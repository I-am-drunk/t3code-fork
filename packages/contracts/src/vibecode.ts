import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TurnId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const VibecodeAuthStatus = Schema.Literals([
  "missing_key",
  "invalid_key",
  "exhausted",
  "available",
  "unknown",
  "refreshing",
]);
export type VibecodeAuthStatus = typeof VibecodeAuthStatus.Type;

export const VibecodeApiKeyStatus = VibecodeAuthStatus;
export type VibecodeApiKeyStatus = typeof VibecodeApiKeyStatus.Type;

export const VibecodeAuthReasonCode = Schema.Literals([
  "missing_key",
  "invalid_key",
  "credits_exhausted",
  "credits_available",
  "credits_unknown",
  "project_access_denied",
  "upstream_unavailable",
  "refresh_in_progress",
  "unknown",
]);
export type VibecodeAuthReasonCode = typeof VibecodeAuthReasonCode.Type;

export const VibecodeCredits = Schema.Struct({
  remainingMinorUnits: NonNegativeInt,
  totalMinorUnits: Schema.optional(NonNegativeInt),
  minorUnitScale: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  resetAt: Schema.optional(IsoDateTime),
  label: Schema.optional(TrimmedNonEmptyString),
  remaining: Schema.optional(NonNegativeInt),
  total: Schema.optional(NonNegativeInt),
});
export type VibecodeCredits = typeof VibecodeCredits.Type;

export const VibecodeApiKeyRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  redacted: TrimmedNonEmptyString,
  source: Schema.Literals(["environment", "stored"]),
  status: VibecodeApiKeyStatus,
  active: Schema.Boolean,
  credits: Schema.optional(VibecodeCredits),
  lastValidatedAt: Schema.optional(IsoDateTime),
  lastUsedAt: Schema.optional(IsoDateTime),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type VibecodeApiKeyRecord = typeof VibecodeApiKeyRecord.Type;

export const VibecodeKeyPoolStatus = Schema.Struct({
  activeKeyId: Schema.optional(TrimmedNonEmptyString),
  keys: Schema.Array(VibecodeApiKeyRecord),
  healthyCount: NonNegativeInt,
  exhaustedCount: NonNegativeInt,
  invalidCount: NonNegativeInt,
  unknownCount: NonNegativeInt,
});
export type VibecodeKeyPoolStatus = typeof VibecodeKeyPoolStatus.Type;

export const VibecodeProjectAccess = Schema.Struct({
  checked: Schema.Boolean,
  allowed: Schema.Boolean,
  projectId: Schema.optional(TrimmedNonEmptyString),
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type VibecodeProjectAccess = typeof VibecodeProjectAccess.Type;

export const VibecodeAuthStatusResult = Schema.Struct({
  status: VibecodeAuthStatus,
  reasonCode: VibecodeAuthReasonCode,
  authenticated: Schema.Boolean,
  source: Schema.Literals(["none", "environment", "stored"]),
  keyPresent: Schema.Boolean,
  creditsKnown: Schema.Boolean,
  credits: Schema.optional(VibecodeCredits),
  keyPool: Schema.optional(VibecodeKeyPoolStatus),
  message: Schema.optional(TrimmedNonEmptyString),
  upstreamReason: Schema.optional(TrimmedNonEmptyString),
  refreshing: Schema.Boolean,
  refreshVersion: NonNegativeInt,
  runtimeInstanceId: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
});
export type VibecodeAuthStatusResult = typeof VibecodeAuthStatusResult.Type;

export const VibecodeRotateApiKeyInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedString),
  projectId: Schema.optional(TrimmedString),
});
export type VibecodeRotateApiKeyInput = typeof VibecodeRotateApiKeyInput.Type;

export const VibecodeRotateApiKeyResult = Schema.Struct({
  accepted: Schema.Boolean,
  status: VibecodeAuthStatus,
  reasonCode: VibecodeAuthReasonCode,
  authenticated: Schema.Boolean,
  keyPresent: Schema.Boolean,
  creditsKnown: Schema.Boolean,
  credits: Schema.optional(VibecodeCredits),
  keyPool: Schema.optional(VibecodeKeyPoolStatus),
  projectAccess: VibecodeProjectAccess,
  message: Schema.optional(TrimmedNonEmptyString),
  upstreamReason: Schema.optional(TrimmedNonEmptyString),
  refreshVersion: NonNegativeInt,
  runtimeInstanceId: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
});
export type VibecodeRotateApiKeyResult = typeof VibecodeRotateApiKeyResult.Type;

export const VibecodeRuntimeStatusInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type VibecodeRuntimeStatusInput = typeof VibecodeRuntimeStatusInput.Type;

export const VibecodePreviewStatusInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type VibecodePreviewStatusInput = typeof VibecodePreviewStatusInput.Type;

export const VibecodeRuntimeStatus = Schema.Struct({
  providerReady: Schema.Boolean,
  status: Schema.Literals(["unconfigured", "ready", "starting", "running", "blocked", "failed"]),
  projectId: Schema.optional(TrimmedNonEmptyString),
  projectName: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  agentUrl: Schema.optional(TrimmedNonEmptyString),
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  previewSource: Schema.optional(
    Schema.Literals(["agent_done", "sandbox_link", "deployment", "manual"]),
  ),
  sandboxStatus: Schema.optional(
    Schema.Literals(["unknown", "starting", "running", "stopped", "error"]),
  ),
  turnStatus: Schema.optional(Schema.Literals(["idle", "running", "blocked", "failed"])),
  activeTurnId: Schema.optional(TurnId),
  vibecodeSessionId: Schema.optional(TrimmedNonEmptyString),
  localMirrorPath: Schema.optional(TrimmedNonEmptyString),
  remoteWorkspacePath: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
  lastError: Schema.optional(TrimmedNonEmptyString),
  lastUpdatedAt: IsoDateTime,
});
export type VibecodeRuntimeStatus = typeof VibecodeRuntimeStatus.Type;

export const VibecodePreviewStatus = Schema.Struct({
  status: Schema.Literals(["unavailable", "starting", "ready", "failed"]),
  url: Schema.optional(TrimmedNonEmptyString),
  source: Schema.optional(Schema.Literals(["agent_done", "sandbox_link", "deployment", "manual"])),
  message: Schema.optional(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
});
export type VibecodePreviewStatus = typeof VibecodePreviewStatus.Type;

export const VibecodeOpenPreviewResult = Schema.Struct({
  opened: Schema.Boolean,
  status: VibecodePreviewStatus,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type VibecodeOpenPreviewResult = typeof VibecodeOpenPreviewResult.Type;

export const VibecodeSyncStatus = Schema.Struct({
  status: Schema.Literals([
    "disabled",
    "uninitialized",
    "pulling",
    "pushing",
    "synced",
    "conflict",
    "failed",
  ]),
  localPath: Schema.optional(TrimmedNonEmptyString),
  remotePath: Schema.optional(TrimmedNonEmptyString),
  lastSyncedAt: Schema.optional(IsoDateTime),
  changedFiles: NonNegativeInt,
  conflictedFiles: Schema.Array(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type VibecodeSyncStatus = typeof VibecodeSyncStatus.Type;
