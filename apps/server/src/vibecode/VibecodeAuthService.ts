import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  type VibecodeApiKeyRecord,
  type VibecodeApiKeyStatus,
  type VibecodeAuthReasonCode,
  type VibecodeAuthStatus,
  type VibecodeAuthStatusResult,
  type VibecodeCredits,
  type VibecodeKeyPoolStatus,
  type VibecodeProjectAccess,
  type VibecodeRotateApiKeyInput,
  type VibecodeRotateApiKeyResult,
} from "@t3tools/contracts";
import { VibecodeApiError, VibecodeClient } from "@t3tools/vibecode-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  deriveStatusFromValidation,
  normalizeLegacyCredits,
  normalizeLegacyVibecodeStatus,
  statusMessage,
} from "./vibecodeAuthDomain.ts";

const KEY_DIR =
  process.env.T3CODE_VIBECODE_KEY_DIR?.trim() || `${homedir().replace(/\/+$/u, "")}/.t3code`;
const KEY_FILE = `${KEY_DIR}/vibecode-auth.json`;
const DEBUG_AUTH = process.env.T3CODE_VIBECODE_AUTH_DEBUG === "1";
const RUNTIME_INSTANCE_ID = `pid:${process.pid}:uptime:${Math.floor(process.uptime())}`;

interface StoredVibecodeKey {
  readonly id: string;
  readonly label: string;
  readonly apiKey: string;
  readonly status: VibecodeApiKeyStatus;
  readonly credits?: VibecodeCredits | undefined;
  readonly lastValidatedAt?: string | undefined;
  readonly lastUsedAt?: string | undefined;
  readonly message?: string | undefined;
  readonly upstreamReason?: string | undefined;
}

interface StoredVibecodeAuthFile {
  readonly version: 3;
  readonly activeKeyId?: string | undefined;
  readonly keys: ReadonlyArray<StoredVibecodeKey>;
}

interface RuntimeEligibility {
  readonly eligible: boolean;
  readonly status: VibecodeAuthStatus;
  readonly reasonCode: VibecodeAuthReasonCode;
  readonly message: string;
  readonly checkedAt: string;
  readonly refreshVersion: number;
  readonly runtimeInstanceId: string;
  readonly source: VibecodeAuthStatusResult["source"];
  readonly apiKey?: string | undefined;
  readonly keyId?: string | undefined;
  readonly credits?: VibecodeCredits | undefined;
  readonly upstreamReason?: string | undefined;
}

interface ResolvedAuthState {
  readonly result: VibecodeAuthStatusResult;
  readonly stored: StoredVibecodeAuthFile;
  readonly source: VibecodeAuthStatusResult["source"];
  readonly activeApiKey?: string | undefined;
  readonly activeKeyId?: string | undefined;
  readonly upstreamReason?: string | undefined;
}

let rotationQueue: Promise<VibecodeRotateApiKeyResult> = Promise.resolve(null as never);
let refreshVersion = 0;

function nextRefreshVersion(): number {
  refreshVersion += 1;
  return refreshVersion;
}

function nowIso(): string {
  return Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
}

function normalizeApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function keyId(apiKey: string): string {
  return `key_${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

function redactApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return "********";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function sanitizeMessage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\s+/gu, " ");
}

function authDebug(_event: string, _payload: Record<string, unknown>): void {}


function storedRecordToPublic(
  key: StoredVibecodeKey,
  activeKeyId: string | undefined,
): VibecodeApiKeyRecord {
  return {
    id: key.id,
    label: key.label,
    redacted: redactApiKey(key.apiKey),
    source: "stored",
    status: key.status,
    active: key.id === activeKeyId,
    ...(key.credits ? { credits: key.credits } : {}),
    ...(key.lastValidatedAt ? { lastValidatedAt: key.lastValidatedAt } : {}),
    ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    ...(key.message ? { message: key.message } : {}),
  };
}

function envRecord(input: {
  readonly apiKey: string;
  readonly status: VibecodeApiKeyStatus;
  readonly activeKeyId?: string | undefined;
  readonly credits?: VibecodeCredits | undefined;
  readonly message?: string | undefined;
}): VibecodeApiKeyRecord {
  const id = keyId(input.apiKey);
  return {
    id,
    label: "Environment key",
    redacted: redactApiKey(input.apiKey),
    source: "environment",
    status: input.status,
    active: id === input.activeKeyId,
    ...(input.credits ? { credits: input.credits } : {}),
    ...(input.message ? { message: input.message } : {}),
  };
}

function keyPoolStatus(input: {
  readonly stored: StoredVibecodeAuthFile;
  readonly envRecord?: VibecodeApiKeyRecord | undefined;
  readonly activeKeyId?: string | undefined;
}): VibecodeKeyPoolStatus {
  const stored = input.stored.keys.map((key) => storedRecordToPublic(key, input.activeKeyId));
  const keys = [...(input.envRecord ? [input.envRecord] : []), ...stored];
  return {
    ...(input.activeKeyId ? { activeKeyId: input.activeKeyId } : {}),
    keys,
    healthyCount: keys.filter((key) => key.status === "available").length,
    exhaustedCount: keys.filter((key) => key.status === "exhausted").length,
    invalidCount: keys.filter((key) => key.status === "invalid_key").length,
    unknownCount: keys.filter(
      (key) => key.status === "unknown" || key.status === "refreshing",
    ).length,
  };
}

function pickActiveStoredKey(stored: StoredVibecodeAuthFile): StoredVibecodeKey | undefined {
  const byId = new Map(stored.keys.map((key) => [key.id, key] as const));
  const active = stored.activeKeyId ? byId.get(stored.activeKeyId) : undefined;
  if (active?.status === "available") return active;
  const byStatus = (status: VibecodeApiKeyStatus) => stored.keys.find((key) => key.status === status);
  return (
    byStatus("available") ??
    active ??
    byStatus("refreshing") ??
    byStatus("unknown") ??
    byStatus("exhausted") ??
    byStatus("invalid_key")
  );
}

async function readStoredAuthFile(): Promise<StoredVibecodeAuthFile> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(KEY_FILE, "utf-8")) as Partial<
      StoredVibecodeAuthFile & {
        apiKey?: string;
        updatedAt?: string;
        credits?: Partial<VibecodeCredits>;
        keys?: Array<
          Partial<
            StoredVibecodeKey & {
              status?: string;
              credits?: Partial<VibecodeCredits>;
            }
          >
        >;
      }
    >;
    if (Array.isArray(parsed.keys)) {
      return {
        version: 3,
        activeKeyId: typeof parsed.activeKeyId === "string" ? parsed.activeKeyId : undefined,
        keys: parsed.keys.flatMap((entry) => {
          const apiKey = normalizeApiKey(entry.apiKey);
          if (!apiKey) return [];
          const normalizedCredits = normalizeLegacyCredits(entry.credits);
          return [
            {
              id: typeof entry.id === "string" ? entry.id : keyId(apiKey),
              label: typeof entry.label === "string" ? entry.label : "Vibecode key",
              apiKey,
              status: normalizeLegacyVibecodeStatus(entry.status),
              ...(normalizedCredits ? { credits: normalizedCredits } : {}),
              ...(typeof entry.lastValidatedAt === "string"
                ? { lastValidatedAt: entry.lastValidatedAt }
                : {}),
              ...(typeof entry.lastUsedAt === "string" ? { lastUsedAt: entry.lastUsedAt } : {}),
              ...(typeof entry.message === "string" ? { message: sanitizeMessage(entry.message) } : {}),
              ...(typeof entry.upstreamReason === "string"
                ? { upstreamReason: sanitizeMessage(entry.upstreamReason) }
                : {}),
            } satisfies StoredVibecodeKey,
          ];
        }),
      };
    }

    const legacyApiKey = normalizeApiKey(parsed.apiKey);
    if (!legacyApiKey || legacyApiKey === "<redacted>") return { version: 3, keys: [] };
    const id = keyId(legacyApiKey);
    const legacyCredits = normalizeLegacyCredits(parsed.credits);
    return {
      version: 3,
      activeKeyId: id,
      keys: [
        {
          id,
          label: "Migrated key",
          apiKey: legacyApiKey,
          status:
            legacyCredits && legacyCredits.remainingMinorUnits <= 0 ? "exhausted" : "refreshing",
          ...(legacyCredits ? { credits: legacyCredits } : {}),
          ...(typeof parsed.updatedAt === "string" ? { lastValidatedAt: parsed.updatedAt } : {}),
        },
      ],
    };
  } catch {
    return { version: 3, keys: [] };
  }
}

async function writeStoredAuthFile(file: StoredVibecodeAuthFile): Promise<void> {
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(KEY_FILE, JSON.stringify(file, null, 2), "utf-8");
  await chmod(KEY_FILE, 0o600);
}

async function validateKey(input: {
  readonly client: VibecodeClient;
  readonly key: StoredVibecodeKey;
  readonly source: VibecodeAuthStatusResult["source"];
  readonly correlationId: string;
}): Promise<StoredVibecodeKey> {
  const checkedAt = nowIso();
  try {
    const validation = await input.client.validateApiKey(input.key.apiKey);
    const normalizedCredits = normalizeLegacyCredits(validation.credits);
    const { status, reasonCode, creditsKnown } = deriveStatusFromValidation({
      keyPresent: true,
      authenticated: validation.authenticated,
      credits: normalizedCredits,
      upstreamUnavailable: false,
    });
    if (validation.diagnostics?.creditsParseState === "invalid") {
      authDebug("credits_parse_invalid", {
        correlationId: input.correlationId,
        source: input.source,
        keyId: input.key.id,
        payloadShape: validation.diagnostics.payloadShape,
      });
    }
    const message = statusMessage({
      status,
      source: input.source,
      upstreamReason: sanitizeMessage(validation.upstreamReason),
    });
    authDebug("key_validated", {
      correlationId: input.correlationId,
      source: input.source,
      keyId: input.key.id,
      status,
      reasonCode,
      creditsKnown,
      creditsMinorUnits: normalizedCredits?.remainingMinorUnits ?? null,
    });
    return {
      ...input.key,
      status,
      lastValidatedAt: checkedAt,
      ...(normalizedCredits ? { credits: normalizedCredits } : { credits: undefined }),
      ...(message ? { message } : { message: undefined }),
      ...(validation.upstreamReason
        ? { upstreamReason: sanitizeMessage(validation.upstreamReason) }
        : { upstreamReason: undefined }),
    };
  } catch (error) {
    const isAuthError = error instanceof VibecodeApiError && (error.status === 401 || error.status === 403);
    const status: VibecodeAuthStatus = isAuthError ? "invalid_key" : "unknown";
    const reasonCode: VibecodeAuthReasonCode = isAuthError
      ? "invalid_key"
      : "upstream_unavailable";
    const message = sanitizeMessage(
      error instanceof Error ? error.message : "Unable to validate Vibecode API key.",
    );
    authDebug("key_validation_failed", {
      correlationId: input.correlationId,
      source: input.source,
      keyId: input.key.id,
      status,
      reasonCode,
      upstreamStatus: error instanceof VibecodeApiError ? error.status ?? null : null,
    });
    return {
      ...input.key,
      status,
      lastValidatedAt: checkedAt,
      message,
      upstreamReason: message,
    };
  }
}

function toAuthResult(input: {
  readonly status: VibecodeAuthStatus;
  readonly reasonCode: VibecodeAuthReasonCode;
  readonly authenticated: boolean;
  readonly source: VibecodeAuthStatusResult["source"];
  readonly keyPresent: boolean;
  readonly creditsKnown: boolean;
  readonly checkedAt: string;
  readonly refreshVersion: number;
  readonly keyPool: VibecodeKeyPoolStatus;
  readonly credits?: VibecodeCredits | undefined;
  readonly message?: string | undefined;
  readonly upstreamReason?: string | undefined;
}): VibecodeAuthStatusResult {
  return {
    status: input.status,
    reasonCode: input.reasonCode,
    authenticated: input.authenticated,
    source: input.source,
    keyPresent: input.keyPresent,
    creditsKnown: input.creditsKnown,
    ...(input.credits ? { credits: input.credits } : {}),
    keyPool: input.keyPool,
    ...(input.message ? { message: input.message } : {}),
    ...(input.upstreamReason ? { upstreamReason: input.upstreamReason } : {}),
    refreshing: false,
    refreshVersion: input.refreshVersion,
    runtimeInstanceId: RUNTIME_INSTANCE_ID,
    checkedAt: input.checkedAt,
  };
}

async function resolveAuthState(input?: {
  readonly projectId?: string | undefined;
  readonly correlationId?: string | undefined;
}): Promise<ResolvedAuthState> {
  const checkedAt = nowIso();
  const currentRefreshVersion = nextRefreshVersion();
  const correlationId = input?.correlationId ?? `vibecode-auth-${randomUUID()}`;
  const envApiKey = normalizeApiKey(process.env.VIBECODE_API_KEY);
  const stored = await readStoredAuthFile();
  const client = new VibecodeClient();

  if (envApiKey) {
    const environmentKey: StoredVibecodeKey = {
      id: keyId(envApiKey),
      label: "Environment key",
      apiKey: envApiKey,
      status: "refreshing",
    };
    const validated = await validateKey({
      client,
      key: environmentKey,
      source: "environment",
      correlationId,
    });

    let status = validated.status;
    let reasonCode: VibecodeAuthReasonCode =
      status === "available"
        ? "credits_available"
        : status === "exhausted"
          ? "credits_exhausted"
          : status === "invalid_key"
            ? "invalid_key"
            : status === "missing_key"
              ? "missing_key"
              : "credits_unknown";
    let message = sanitizeMessage(validated.message);

    if (input?.projectId && validated.status === "available") {
      const projectAccess = await client.checkProjectAccess(envApiKey, input.projectId);
      if (!projectAccess.allowed) {
        status = "unknown";
        reasonCode = "project_access_denied";
        message = sanitizeMessage(
          projectAccess.reason ?? "The configured Vibecode key cannot access this project.",
        );
      }
    }

    const envKeyPoolRecord = envRecord({
      apiKey: envApiKey,
      status,
      activeKeyId: keyId(envApiKey),
      ...(validated.credits ? { credits: validated.credits } : {}),
      ...(message ? { message } : {}),
    });
    const keyPool = keyPoolStatus({
      stored,
      envRecord: envKeyPoolRecord,
      activeKeyId: keyId(envApiKey),
    });

    const result = toAuthResult({
      status,
      reasonCode,
      authenticated: status === "available" || status === "exhausted",
      source: "environment",
      keyPresent: true,
      creditsKnown: Boolean(validated.credits),
      ...(validated.credits ? { credits: validated.credits } : {}),
      keyPool,
      ...(message ? { message } : {}),
      ...(validated.upstreamReason ? { upstreamReason: validated.upstreamReason } : {}),
      checkedAt,
      refreshVersion: currentRefreshVersion,
    });

    return {
      result,
      stored,
      source: "environment",
      activeApiKey: envApiKey,
      activeKeyId: keyId(envApiKey),
      ...(validated.upstreamReason ? { upstreamReason: validated.upstreamReason } : {}),
    };
  }

  if (stored.keys.length === 0) {
    const keyPool = keyPoolStatus({ stored });
    return {
      result: toAuthResult({
        status: "missing_key",
        reasonCode: "missing_key",
        authenticated: false,
        source: "none",
        keyPresent: false,
        creditsKnown: false,
        keyPool,
        message: statusMessage({ status: "missing_key", source: "none", upstreamReason: undefined }),
        checkedAt,
        refreshVersion: currentRefreshVersion,
      }),
      stored,
      source: "none",
    };
  }

  const validatedKeys = await Promise.all(
    stored.keys.map((key) => validateKey({ client, key, source: "stored", correlationId })),
  );
  const nextStored: StoredVibecodeAuthFile = {
    version: 3,
    activeKeyId: stored.activeKeyId,
    keys: validatedKeys,
  };
  const active = pickActiveStoredKey(nextStored);
  const finalizedStored: StoredVibecodeAuthFile = {
    ...nextStored,
    ...(active ? { activeKeyId: active.id } : {}),
  };
  await writeStoredAuthFile(finalizedStored);

  if (!active) {
    const keyPool = keyPoolStatus({ stored: finalizedStored });
    return {
      result: toAuthResult({
        status: "missing_key",
        reasonCode: "missing_key",
        authenticated: false,
        source: "none",
        keyPresent: false,
        creditsKnown: false,
        keyPool,
        message: statusMessage({ status: "missing_key", source: "none", upstreamReason: undefined }),
        checkedAt,
        refreshVersion: currentRefreshVersion,
      }),
      stored: finalizedStored,
      source: "none",
    };
  }

  let status = active.status;
  let reasonCode: VibecodeAuthReasonCode =
    status === "available"
      ? "credits_available"
      : status === "exhausted"
        ? "credits_exhausted"
        : status === "invalid_key"
          ? "invalid_key"
          : status === "missing_key"
            ? "missing_key"
            : "credits_unknown";
  let message = sanitizeMessage(active.message);

  if (input?.projectId && status === "available") {
    const access = await client.checkProjectAccess(active.apiKey, input.projectId);
    if (!access.allowed) {
      status = "unknown";
      reasonCode = "project_access_denied";
      message = sanitizeMessage(access.reason ?? "The active key cannot access this Vibecode project.");
    }
  }

  const keyPool = keyPoolStatus({
    stored: finalizedStored,
    activeKeyId: active.id,
  });

  const result = toAuthResult({
    status,
    reasonCode,
    authenticated: status === "available" || status === "exhausted",
    source: "stored",
    keyPresent: true,
    creditsKnown: Boolean(active.credits),
    ...(active.credits ? { credits: active.credits } : {}),
    keyPool,
    ...(message ? { message } : {}),
    ...(active.upstreamReason ? { upstreamReason: active.upstreamReason } : {}),
    checkedAt,
    refreshVersion: currentRefreshVersion,
  });

  return {
    result,
    stored: finalizedStored,
    source: "stored",
    activeApiKey: active.apiKey,
    activeKeyId: active.id,
    ...(active.upstreamReason ? { upstreamReason: active.upstreamReason } : {}),
  };
}

export async function getVibecodeAuthStatus(input?: {
  readonly projectId?: string | undefined;
  readonly correlationId?: string | undefined;
}): Promise<VibecodeAuthStatusResult> {
  const resolved = await resolveAuthState(input);
  authDebug("auth_status", {
    correlationId: input?.correlationId ?? null,
    status: resolved.result.status,
    reasonCode: resolved.result.reasonCode,
    source: resolved.result.source,
    keyPresent: resolved.result.keyPresent,
    creditsKnown: resolved.result.creditsKnown,
    refreshVersion: resolved.result.refreshVersion,
  });
  return resolved.result;
}

export async function getVibecodeRuntimeEligibility(input?: {
  readonly projectId?: string | undefined;
  readonly correlationId?: string | undefined;
}): Promise<RuntimeEligibility> {
  const correlationId = input?.correlationId ?? `vibecode-runtime-${randomUUID()}`;
  const resolved = await resolveAuthState({
    projectId: input?.projectId,
    correlationId,
  });

  const blocked =
    resolved.result.status === "missing_key" ||
    resolved.result.status === "invalid_key" ||
    resolved.result.status === "exhausted" ||
    resolved.result.status === "unknown";

  const message =
    sanitizeMessage(resolved.result.message) ??
    statusMessage({
      status: resolved.result.status,
      source: resolved.result.source,
      upstreamReason: resolved.result.upstreamReason,
    });

  const eligibility: RuntimeEligibility = {
    eligible: !blocked,
    status: resolved.result.status,
    reasonCode: resolved.result.reasonCode,
    message,
    checkedAt: resolved.result.checkedAt,
    refreshVersion: resolved.result.refreshVersion,
    runtimeInstanceId: resolved.result.runtimeInstanceId,
    source: resolved.result.source,
    ...(resolved.activeApiKey ? { apiKey: resolved.activeApiKey } : {}),
    ...(resolved.activeKeyId ? { keyId: resolved.activeKeyId } : {}),
    ...(resolved.result.credits ? { credits: resolved.result.credits } : {}),
    ...(resolved.result.upstreamReason ? { upstreamReason: resolved.result.upstreamReason } : {}),
  };

  authDebug("runtime_eligibility", {
    correlationId,
    eligible: eligibility.eligible,
    status: eligibility.status,
    reasonCode: eligibility.reasonCode,
    source: eligibility.source,
    refreshVersion: eligibility.refreshVersion,
  });

  return eligibility;
}

async function rotateApiKeyNow(input: VibecodeRotateApiKeyInput): Promise<VibecodeRotateApiKeyResult> {
  const checkedAt = nowIso();
  const apiKey = input.apiKey.trim();
  const client = new VibecodeClient();
  const correlationId = `vibecode-rotate-${randomUUID()}`;

  let validation: Awaited<ReturnType<VibecodeClient["validateApiKey"]>>;
  try {
    validation = await client.validateApiKey(apiKey);
  } catch (error) {
    const status = error instanceof VibecodeApiError && (error.status === 401 || error.status === 403)
      ? "invalid_key"
      : "unknown";
    const reasonCode: VibecodeAuthReasonCode =
      status === "invalid_key" ? "invalid_key" : "upstream_unavailable";
    const message = sanitizeMessage(
      error instanceof Error ? error.message : "Unable to validate Vibecode API key.",
    );
    const keyPool = keyPoolStatus({ stored: await readStoredAuthFile() });
    return {
      accepted: false,
      status,
      reasonCode,
      authenticated: false,
      keyPresent: true,
      creditsKnown: false,
      keyPool,
      projectAccess: { checked: false, allowed: false },
      ...(message ? { message } : {}),
      ...(message ? { upstreamReason: message } : {}),
      refreshVersion: nextRefreshVersion(),
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      checkedAt,
    };
  }

  const normalizedCredits = normalizeLegacyCredits(validation.credits);
  const derived = deriveStatusFromValidation({
    keyPresent: true,
    authenticated: validation.authenticated,
    credits: normalizedCredits,
    upstreamUnavailable: false,
  });

  if (derived.status !== "available") {
    const statusMessageValue =
      derived.status === "exhausted"
        ? "The new Vibecode API key is valid but credits are exhausted."
        : derived.status === "invalid_key"
          ? validation.message ?? "Vibecode rejected the new API key."
          : "Vibecode accepted the key, but credits are unavailable.";
    const keyPool = keyPoolStatus({ stored: await readStoredAuthFile() });
    return {
      accepted: false,
      status: derived.status,
      reasonCode: derived.reasonCode,
      authenticated: derived.status === "exhausted",
      keyPresent: true,
      creditsKnown: derived.creditsKnown,
      ...(normalizedCredits ? { credits: normalizedCredits } : {}),
      keyPool,
      projectAccess: { checked: false, allowed: derived.status !== "invalid_key" },
      message: statusMessageValue,
      ...(validation.upstreamReason ? { upstreamReason: sanitizeMessage(validation.upstreamReason) } : {}),
      refreshVersion: nextRefreshVersion(),
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      checkedAt,
    };
  }

  const projectAccess: VibecodeProjectAccess = await client.checkProjectAccess(
    apiKey,
    input.projectId,
  );
  if (!projectAccess.allowed) {
    const keyPool = keyPoolStatus({ stored: await readStoredAuthFile() });
    const reason = sanitizeMessage(projectAccess.reason) ?? "The new key cannot access the active project.";
    return {
      accepted: false,
      status: "unknown",
      reasonCode: "project_access_denied",
      authenticated: true,
      keyPresent: true,
      creditsKnown: true,
      ...(normalizedCredits ? { credits: normalizedCredits } : {}),
      keyPool,
      projectAccess,
      message: reason,
      ...(reason ? { upstreamReason: reason } : {}),
      refreshVersion: nextRefreshVersion(),
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      checkedAt,
    };
  }

  const stored = await readStoredAuthFile();
  const id = keyId(apiKey);
  const label = input.label?.trim() || `Vibecode key ${stored.keys.length + 1}`;
  const nextKey: StoredVibecodeKey = {
    id,
    label,
    apiKey,
    status: "available",
    lastValidatedAt: checkedAt,
    lastUsedAt: checkedAt,
    ...(normalizedCredits ? { credits: normalizedCredits } : {}),
    ...(validation.upstreamReason
      ? { upstreamReason: sanitizeMessage(validation.upstreamReason) }
      : {}),
  };
  const nextStored: StoredVibecodeAuthFile = {
    version: 3,
    activeKeyId: id,
    keys: [...stored.keys.filter((key) => key.id !== id), nextKey],
  };
  await writeStoredAuthFile(nextStored);

  const refreshed = await resolveAuthState({
    projectId: input.projectId,
    correlationId,
  });

  return {
    accepted: refreshed.result.status === "available",
    status: refreshed.result.status,
    reasonCode: refreshed.result.reasonCode,
    authenticated: refreshed.result.authenticated,
    keyPresent: refreshed.result.keyPresent,
    creditsKnown: refreshed.result.creditsKnown,
    ...(refreshed.result.credits ? { credits: refreshed.result.credits } : {}),
    keyPool: refreshed.result.keyPool,
    projectAccess,
    message:
      refreshed.result.status === "available"
        ? "Vibecode API key updated."
        : refreshed.result.message,
    ...(refreshed.result.upstreamReason
      ? { upstreamReason: refreshed.result.upstreamReason }
      : {}),
    refreshVersion: refreshed.result.refreshVersion,
    runtimeInstanceId: refreshed.result.runtimeInstanceId,
    checkedAt: refreshed.result.checkedAt,
  };
}

export function rotateVibecodeApiKey(
  input: VibecodeRotateApiKeyInput,
): Promise<VibecodeRotateApiKeyResult> {
  const next = rotationQueue.catch(() => null).then(() => rotateApiKeyNow(input));
  rotationQueue = next;
  return next;
}

export async function readVibecodeApiKeyForProvider(projectId?: string): Promise<string | null> {
  const eligibility = await getVibecodeRuntimeEligibility({ projectId });
  return eligibility.eligible && eligibility.apiKey ? eligibility.apiKey : null;
}

export async function markActiveVibecodeKeyUsed(): Promise<void> {
  const envApiKey = normalizeApiKey(process.env.VIBECODE_API_KEY);
  if (envApiKey) return;

  const stored = await readStoredAuthFile();
  const active = pickActiveStoredKey(stored);
  if (!active) return;
  const nextKeys = [...stored.keys];
  const activeIndex = nextKeys.findIndex((key) => key.id === active.id);
  if (activeIndex < 0) return;
  nextKeys[activeIndex] = { ...nextKeys[activeIndex]!, lastUsedAt: nowIso() };
  await writeStoredAuthFile({
    ...stored,
    activeKeyId: active.id,
    keys: nextKeys,
  });
}

export function createVibecodeKeyLabel(): string {
  return `Vibecode key ${randomUUID().slice(0, 8)}`;
}
