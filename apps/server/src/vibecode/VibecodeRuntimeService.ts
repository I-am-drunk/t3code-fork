import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  ThreadId,
  TurnId,
  VibecodePreviewStatus,
  VibecodeRuntimeStatus,
  VibecodeSyncStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

type PreviewSource = NonNullable<VibecodeRuntimeStatus["previewSource"]>;

interface RuntimeState {
  readonly threadId: ThreadId;
  projectId?: string | undefined;
  projectName?: string | undefined;
  model?: string | undefined;
  agentUrl?: string | undefined;
  previewUrl?: string | undefined;
  previewSource?: PreviewSource | undefined;
  sandboxStatus?: VibecodeRuntimeStatus["sandboxStatus"] | undefined;
  turnStatus?: NonNullable<VibecodeRuntimeStatus["turnStatus"]> | undefined;
  activeTurnId?: TurnId | undefined;
  vibecodeSessionId?: string | undefined;
  localMirrorPath?: string | undefined;
  remoteWorkspacePath?: string | undefined;
  message?: string | undefined;
  lastError?: string | undefined;
  updatedAt: string;
}

const states = new Map<string, RuntimeState>();

function nowIso(): string {
  return Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function safeUrl(value: string | undefined): string | undefined {
  const trimmed = clean(value);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function mirrorPathForProject(projectId: string | undefined): string | undefined {
  const normalized = clean(projectId)?.replace(/[^a-zA-Z0-9._-]/gu, "-");
  const home = clean(process.env.HOME) ?? clean(process.env.USERPROFILE);
  return normalized && home
    ? [home.replace(/\/+$/u, ""), ".t3code", "vibecode", "projects", normalized].join("/")
    : undefined;
}

function emptyRuntimeStatus(): VibecodeRuntimeStatus {
  return {
    providerReady: false,
    status: "unconfigured",
    turnStatus: "idle",
    lastUpdatedAt: nowIso(),
    message:
      "Configure a Vibecode project ID or direct agent URL to enable native preview/runtime status.",
  };
}

export function upsertVibecodeRuntimeState(
  threadId: ThreadId,
  patch: Omit<Partial<RuntimeState>, "threadId" | "updatedAt">,
): RuntimeState {
  const existing = states.get(threadId);
  const projectId = clean(patch.projectId) ?? existing?.projectId;
  const next: RuntimeState = {
    ...(existing ?? { threadId, updatedAt: nowIso() }),
    ...patch,
    threadId,
    ...(projectId ? { projectId } : {}),
    ...((clean(patch.localMirrorPath) ??
    existing?.localMirrorPath ??
    mirrorPathForProject(projectId))
      ? {
          localMirrorPath:
            clean(patch.localMirrorPath) ??
            existing?.localMirrorPath ??
            mirrorPathForProject(projectId),
        }
      : {}),
    updatedAt: nowIso(),
  };
  states.set(threadId, next);
  return next;
}

export function readVibecodeRuntimeState(threadId: ThreadId | undefined): RuntimeState | undefined {
  if (threadId) return states.get(threadId);
  return [...states.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function serializeVibecodeResumeCursor(threadId: ThreadId): unknown {
  const state = states.get(threadId);
  if (!state) return undefined;
  return {
    vibecode: {
      version: 1,
      sessionId: state.vibecodeSessionId,
      projectId: state.projectId,
      projectName: state.projectName,
      agentUrl: state.agentUrl,
      previewUrl: state.previewUrl,
      previewSource: state.previewSource,
      localMirrorPath: state.localMirrorPath,
      remoteWorkspacePath: state.remoteWorkspacePath,
      model: state.model,
      updatedAt: state.updatedAt,
    },
  };
}

export function restoreVibecodeRuntimeFromCursor(threadId: ThreadId, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  const vibecode = root.vibecode;
  if (!vibecode || typeof vibecode !== "object" || Array.isArray(vibecode)) return;
  const record = vibecode as Record<string, unknown>;
  upsertVibecodeRuntimeState(threadId, {
    vibecodeSessionId: clean(record.sessionId as string | undefined),
    projectId: clean(record.projectId as string | undefined),
    projectName: clean(record.projectName as string | undefined),
    agentUrl: safeUrl(record.agentUrl as string | undefined),
    previewUrl: safeUrl(record.previewUrl as string | undefined),
    previewSource:
      (clean(record.previewSource as string | undefined) as PreviewSource) ?? undefined,
    localMirrorPath: clean(record.localMirrorPath as string | undefined),
    remoteWorkspacePath: clean(record.remoteWorkspacePath as string | undefined),
    model: clean(record.model as string | undefined),
    turnStatus: "idle",
    message: "Restored Vibecode runtime state.",
  });
}

export async function ensureVibecodeLocalMirror(
  projectId: string | undefined,
): Promise<string | undefined> {
  const localPath = mirrorPathForProject(projectId);
  if (!localPath) return undefined;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(localPath, { recursive: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  return localPath;
}

export function getVibecodeRuntimeStatus(input: {
  readonly threadId?: ThreadId | undefined;
}): VibecodeRuntimeStatus {
  const state = readVibecodeRuntimeState(input.threadId);
  if (!state) return emptyRuntimeStatus();
  const providerReady = Boolean(state.agentUrl || state.projectId);
  return {
    providerReady,
    status:
      state.turnStatus === "running"
        ? "running"
        : state.turnStatus === "blocked"
          ? "blocked"
          : state.lastError
            ? "failed"
            : providerReady
              ? "ready"
              : "unconfigured",
    ...(state.projectId ? { projectId: state.projectId } : {}),
    ...(state.projectName ? { projectName: state.projectName } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.agentUrl ? { agentUrl: state.agentUrl } : {}),
    ...(state.previewUrl ? { previewUrl: state.previewUrl } : {}),
    ...(state.previewSource ? { previewSource: state.previewSource } : {}),
    ...(state.sandboxStatus ? { sandboxStatus: state.sandboxStatus } : {}),
    turnStatus: state.turnStatus ?? "idle",
    ...(state.activeTurnId ? { activeTurnId: state.activeTurnId } : {}),
    ...(state.vibecodeSessionId ? { vibecodeSessionId: state.vibecodeSessionId } : {}),
    ...(state.localMirrorPath ? { localMirrorPath: state.localMirrorPath } : {}),
    ...(state.remoteWorkspacePath ? { remoteWorkspacePath: state.remoteWorkspacePath } : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    lastUpdatedAt: state.updatedAt,
  };
}

export function getVibecodePreviewStatus(input: {
  readonly threadId?: ThreadId | undefined;
}): VibecodePreviewStatus {
  const state = readVibecodeRuntimeState(input.threadId);
  const checkedAt = nowIso();
  if (!state) {
    return {
      status: "unavailable",
      checkedAt,
      message: "No Vibecode runtime has reported a preview URL yet.",
    };
  }
  const url = safeUrl(state.previewUrl);
  if (url) {
    return {
      status: "ready",
      url,
      source: state.previewSource ?? "sandbox_link",
      checkedAt,
    };
  }
  if (state.turnStatus === "running") {
    return {
      status: "starting",
      checkedAt,
      message: "The Vibecode agent is still preparing the preview.",
    };
  }
  return {
    status: "unavailable",
    checkedAt,
    message: "Preview is available after Vibecode returns a sandbox preview URL.",
  };
}

export function getVibecodeSyncStatus(input: {
  readonly threadId?: ThreadId | undefined;
}): VibecodeSyncStatus {
  const state = readVibecodeRuntimeState(input.threadId);
  return {
    status: "disabled",
    ...(state?.localMirrorPath ? { localPath: state.localMirrorPath } : {}),
    ...(state?.remoteWorkspacePath ? { remotePath: state.remoteWorkspacePath } : {}),
    changedFiles: 0,
    conflictedFiles: [],
    message:
      "Local mirror status is available. Automatic SSH sync is disabled until remote sync tooling is configured.",
  };
}
