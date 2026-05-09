import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { VibecodeClient } from "@t3tools/vibecode-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type {
  VibecodeApiKeyRecord,
  VibecodeApiKeyStatus,
  VibecodeAuthStatusResult,
  VibecodeCredits,
  VibecodeKeyPoolStatus,
  VibecodeProjectAccess,
  VibecodeRotateApiKeyInput,
  VibecodeRotateApiKeyResult,
} from "@t3tools/contracts";

const KEY_DIR = `${homedir()}/.t3code`;
const KEY_FILE = `${KEY_DIR}/vibecode-auth.json`;

interface StoredVibecodeKey {
  readonly id: string;
  readonly label: string;
  readonly apiKey: string;
  readonly status: VibecodeApiKeyStatus;
  readonly credits?: VibecodeCredits | undefined;
  readonly lastValidatedAt?: string | undefined;
  readonly lastUsedAt?: string | undefined;
  readonly message?: string | undefined;
}

interface StoredVibecodeAuthFile {
  readonly version: 2;
  readonly activeKeyId?: string | undefined;
  readonly keys: ReadonlyArray<StoredVibecodeKey>;
}

let rotationQueue: Promise<VibecodeRotateApiKeyResult> = Promise.resolve(null as never);

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

function statusFromCredits(credits: VibecodeCredits | undefined): "valid" | "exhausted" {
  return credits && credits.remaining <= 0 ? "exhausted" : "valid";
}

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

function envRecord(apiKey: string, activeKeyId: string | undefined): VibecodeApiKeyRecord {
  const id = keyId(apiKey);
  return {
    id,
    label: "Environment key",
    redacted: redactApiKey(apiKey),
    source: "environment",
    status: "checking",
    active: id === activeKeyId,
  };
}

async function readStoredAuthFile(): Promise<StoredVibecodeAuthFile> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(KEY_FILE, "utf-8")) as Partial<
      StoredVibecodeAuthFile & { apiKey?: string; updatedAt?: string; credits?: VibecodeCredits }
    >;
    if (Array.isArray(parsed.keys)) {
      return {
        version: 2,
        activeKeyId: typeof parsed.activeKeyId === "string" ? parsed.activeKeyId : undefined,
        keys: parsed.keys.flatMap((entry) => {
          const apiKey = normalizeApiKey(entry.apiKey);
          if (!apiKey) return [];
          return [
            {
              id: typeof entry.id === "string" ? entry.id : keyId(apiKey),
              label: typeof entry.label === "string" ? entry.label : "Vibecode key",
              apiKey,
              status: entry.status ?? "checking",
              ...(entry.credits ? { credits: entry.credits } : {}),
              ...(typeof entry.lastValidatedAt === "string"
                ? { lastValidatedAt: entry.lastValidatedAt }
                : {}),
              ...(typeof entry.lastUsedAt === "string" ? { lastUsedAt: entry.lastUsedAt } : {}),
              ...(typeof entry.message === "string" ? { message: entry.message } : {}),
            },
          ];
        }),
      };
    }

    const legacyApiKey = normalizeApiKey(parsed.apiKey);
    if (!legacyApiKey || legacyApiKey === "<redacted>") return { version: 2, keys: [] };
    const id = keyId(legacyApiKey);
    return {
      version: 2,
      activeKeyId: id,
      keys: [
        {
          id,
          label: "Migrated key",
          apiKey: legacyApiKey,
          status: parsed.credits && parsed.credits.remaining <= 0 ? "exhausted" : "checking",
          ...(parsed.credits ? { credits: parsed.credits } : {}),
          ...(typeof parsed.updatedAt === "string" ? { lastValidatedAt: parsed.updatedAt } : {}),
        },
      ],
    };
  } catch {
    return { version: 2, keys: [] };
  }
}

async function writeStoredAuthFile(file: StoredVibecodeAuthFile): Promise<void> {
  const { mkdir, chmod } = await import("node:fs/promises");
  await mkdir(KEY_DIR, { recursive: true, mode: 0o700 });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(KEY_FILE, JSON.stringify(file, null, 2), "utf-8");
  await chmod(KEY_FILE, 0o600);
}

function keyPoolStatus(input: {
  readonly stored: StoredVibecodeAuthFile;
  readonly envApiKey?: string | undefined;
  readonly activeKeyId?: string | undefined;
}): VibecodeKeyPoolStatus {
  const env = input.envApiKey ? [envRecord(input.envApiKey, input.activeKeyId)] : [];
  const stored = input.stored.keys.map((key) => storedRecordToPublic(key, input.activeKeyId));
  const keys = [...env, ...stored];
  return {
    ...(input.activeKeyId ? { activeKeyId: input.activeKeyId } : {}),
    keys,
    healthyCount: keys.filter((key) => key.status === "valid" || key.status === "checking").length,
    exhaustedCount: keys.filter((key) => key.status === "exhausted").length,
    invalidCount: keys.filter((key) => key.status === "invalid").length,
  };
}

async function validateStoredKey(
  client: VibecodeClient,
  key: StoredVibecodeKey,
): Promise<StoredVibecodeKey> {
  const checkedAt = nowIso();
  try {
    const validation = await client.validateApiKey(key.apiKey);
    if (!validation.authenticated) {
      return {
        ...key,
        status: "invalid",
        lastValidatedAt: checkedAt,
        message: validation.message ?? "Vibecode rejected this API key.",
      };
    }
    return {
      ...key,
      status: statusFromCredits(validation.credits),
      lastValidatedAt: checkedAt,
      ...(validation.credits ? { credits: validation.credits } : {}),
      ...(validation.credits && validation.credits.remaining <= 0
        ? { message: "This Vibecode API key has no remaining credits." }
        : { message: undefined }),
    };
  } catch (error) {
    return {
      ...key,
      status: "invalid",
      lastValidatedAt: checkedAt,
      message: error instanceof Error ? error.message : "Unable to validate Vibecode API key.",
    };
  }
}

async function resolveActiveKey(projectId?: string): Promise<{
  readonly apiKey: string | null;
  readonly keyId?: string | undefined;
  readonly source: VibecodeAuthStatusResult["source"];
  readonly stored: StoredVibecodeAuthFile;
  readonly envApiKey?: string | undefined;
}> {
  const stored = await readStoredAuthFile();
  const envApiKey = normalizeApiKey(process.env.VIBECODE_API_KEY);
  if (envApiKey) {
    return { apiKey: envApiKey, keyId: keyId(envApiKey), source: "environment", stored, envApiKey };
  }

  const active =
    stored.keys.find((key) => key.id === stored.activeKeyId && key.status !== "invalid") ??
    stored.keys.find((key) => key.status === "valid") ??
    stored.keys.find((key) => key.status === "checking") ??
    null;
  if (!active) return { apiKey: null, source: "none", stored, envApiKey };

  if (projectId) {
    const access = await new VibecodeClient().checkProjectAccess(active.apiKey, projectId);
    if (!access.allowed) return { apiKey: null, source: "none", stored, envApiKey };
  }
  return { apiKey: active.apiKey, keyId: active.id, source: "stored", stored, envApiKey };
}

export async function getVibecodeAuthStatus(): Promise<VibecodeAuthStatusResult> {
  const checkedAt = nowIso();
  const envApiKey = normalizeApiKey(process.env.VIBECODE_API_KEY);
  let stored = await readStoredAuthFile();
  const client = new VibecodeClient();

  if (envApiKey) {
    try {
      const validation = await client.validateApiKey(envApiKey);
      const status = validation.authenticated ? statusFromCredits(validation.credits) : "invalid";
      const envNotice =
        stored.keys.length > 0
          ? "Using Vibecode API key from the environment; stored keys are ignored. "
          : "Using Vibecode API key from the environment. ";
      return {
        status,
        authenticated: validation.authenticated,
        source: "environment",
        checkedAt,
        ...(validation.credits ? { credits: validation.credits } : {}),
        keyPool: keyPoolStatus({ stored, envApiKey, activeKeyId: keyId(envApiKey) }),
        ...(status === "exhausted"
          ? { message: `${envNotice}Your Vibecode credits are exhausted.` }
          : {}),
        ...(!validation.authenticated
          ? {
              message: `${envNotice}${validation.message ?? "Vibecode rejected the configured API key."}`,
            }
          : {}),
      };
    } catch (error) {
      return {
        status: "invalid",
        authenticated: false,
        source: "environment",
        checkedAt,
        keyPool: keyPoolStatus({ stored, envApiKey, activeKeyId: keyId(envApiKey) }),
        message:
          stored.keys.length > 0
            ? `Using Vibecode API key from the environment; stored keys are ignored. ${error instanceof Error ? error.message : "Unable to validate Vibecode API key."}`
            : error instanceof Error
              ? `Using Vibecode API key from the environment. ${error.message}`
              : "Using Vibecode API key from the environment. Unable to validate Vibecode API key.",
      };
    }
  }

  if (stored.keys.length === 0) {
    return {
      status: "missing",
      authenticated: false,
      source: "none",
      checkedAt,
      keyPool: keyPoolStatus({ stored }),
      message: "Add a Vibecode API key to use Vibecode models.",
    };
  }

  const nextKeys = await Promise.all(stored.keys.map((key) => validateStoredKey(client, key)));
  stored = {
    ...stored,
    keys: nextKeys,
    activeKeyId:
      stored.activeKeyId && nextKeys.some((key) => key.id === stored.activeKeyId)
        ? stored.activeKeyId
        : nextKeys.find((key) => key.status === "valid")?.id,
  };
  await writeStoredAuthFile(stored);
  const active = nextKeys.find((key) => key.id === stored.activeKeyId) ?? nextKeys[0];
  return {
    status: active?.status ?? "missing",
    authenticated: active?.status === "valid" || active?.status === "exhausted",
    source: active ? "stored" : "none",
    checkedAt,
    ...(active?.credits ? { credits: active.credits } : {}),
    keyPool: keyPoolStatus({ stored, activeKeyId: active?.id }),
    ...(active?.message ? { message: active.message } : {}),
  };
}

async function rotateApiKeyNow(
  input: VibecodeRotateApiKeyInput,
): Promise<VibecodeRotateApiKeyResult> {
  const checkedAt = nowIso();
  const apiKey = input.apiKey.trim();
  const client = new VibecodeClient();
  let validation: Awaited<ReturnType<VibecodeClient["validateApiKey"]>>;
  try {
    validation = await client.validateApiKey(apiKey);
  } catch (error) {
    const stored = await readStoredAuthFile();
    return {
      accepted: false,
      status: "invalid",
      authenticated: false,
      checkedAt,
      keyPool: keyPoolStatus({ stored }),
      projectAccess: { checked: false, allowed: false },
      message: error instanceof Error ? error.message : "Unable to validate Vibecode API key.",
    };
  }

  if (!validation.authenticated) {
    const stored = await readStoredAuthFile();
    return {
      accepted: false,
      status: "invalid",
      authenticated: false,
      checkedAt,
      keyPool: keyPoolStatus({ stored }),
      projectAccess: { checked: false, allowed: false },
      message: validation.message ?? "Vibecode rejected the new API key.",
    };
  }

  const status = statusFromCredits(validation.credits);
  if (status === "exhausted") {
    const stored = await readStoredAuthFile();
    return {
      accepted: false,
      status,
      authenticated: true,
      checkedAt,
      ...(validation.credits ? { credits: validation.credits } : {}),
      keyPool: keyPoolStatus({ stored }),
      projectAccess: { checked: false, allowed: true },
      message: "The new Vibecode API key is valid but has no remaining credits.",
    };
  }

  const projectAccess: VibecodeProjectAccess = await client.checkProjectAccess(
    apiKey,
    input.projectId,
  );
  if (!projectAccess.allowed) {
    const stored = await readStoredAuthFile();
    return {
      accepted: false,
      status,
      authenticated: true,
      checkedAt,
      ...(validation.credits ? { credits: validation.credits } : {}),
      keyPool: keyPoolStatus({ stored }),
      projectAccess,
      message: projectAccess.reason ?? "The new key cannot access the active project.",
    };
  }

  const stored = await readStoredAuthFile();
  const id = keyId(apiKey);
  const label = input.label?.trim() || `Vibecode key ${stored.keys.length + 1}`;
  const nextKey: StoredVibecodeKey = {
    id,
    label,
    apiKey,
    status,
    lastValidatedAt: checkedAt,
    lastUsedAt: checkedAt,
    ...(validation.credits ? { credits: validation.credits } : {}),
  };
  const nextStored: StoredVibecodeAuthFile = {
    version: 2,
    activeKeyId: id,
    keys: [...stored.keys.filter((key) => key.id !== id), nextKey],
  };
  await writeStoredAuthFile(nextStored);

  return {
    accepted: true,
    status,
    authenticated: true,
    checkedAt,
    ...(validation.credits ? { credits: validation.credits } : {}),
    keyPool: keyPoolStatus({ stored: nextStored, activeKeyId: id }),
    projectAccess,
    message: "Vibecode API key updated.",
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
  const resolved = await resolveActiveKey(projectId);
  return resolved.apiKey;
}

export async function markActiveVibecodeKeyUsed(): Promise<void> {
  const stored = await readStoredAuthFile();
  if (!stored.activeKeyId) return;
  const nextKeys = [...stored.keys];
  const activeIndex = nextKeys.findIndex((key) => key.id === stored.activeKeyId);
  if (activeIndex < 0) return;
  nextKeys[activeIndex] = { ...nextKeys[activeIndex]!, lastUsedAt: nowIso() };
  await writeStoredAuthFile({
    ...stored,
    keys: nextKeys,
  });
}

export function createVibecodeKeyLabel(): string {
  return `Vibecode key ${randomUUID().slice(0, 8)}`;
}
