import {
  EnvironmentId,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 3 as const;
// Drop cached history windows that bypassed the row and byte budgets.
export const ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION = 5 as const;
export const MAX_THREAD_CACHE_BYTES = 2 * 1_048_576;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

const decodeThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);

class ThreadCacheSizeError extends Schema.TaggedError<ThreadCacheSizeError>()(
  "ThreadCacheSizeError",
  {},
) {
  override get message(): string {
    return "Thread cache exceeds the history size limit.";
  }
}

/** Reject oversized caches before JSON parsing and schema traversal. */
export const decodeStoredOrchestrationThreadSnapshot = Effect.fn(
  "OrchestrationCache.decodeThreadSnapshot",
)(function* (raw: string) {
  if (
    raw.length > MAX_THREAD_CACHE_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_THREAD_CACHE_BYTES
  ) {
    return yield* new ThreadCacheSizeError({});
  }
  return yield* decodeThreadSnapshot(raw);
});

export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
