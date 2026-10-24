import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, EventId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  MAX_THREAD_CACHE_BYTES,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
  decodeStoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadId,
} from "../state/orchestrationV2TestFixtures.ts";

import { applyOrchestrationV2ProjectionEvent } from "../state/orchestrationV2Projection.ts";

const environmentId = EnvironmentId.make("environment-cache-test");
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
const encodeStoredShellSnapshot = Schema.encodeSync(StoredOrchestrationShellSnapshot);
const decodeStoredShellSnapshotSync = Schema.decodeUnknownSync(StoredOrchestrationShellSnapshot);
const encodeStoredThreadSnapshotJson = Schema.encodeSync(StoredThreadSnapshotJson);
const decodeStoredThreadSnapshotJson = Schema.decodeUnknownSync(StoredThreadSnapshotJson);

class TestCacheDecodeError extends Schema.TaggedError<TestCacheDecodeError>()(
  "TestCacheDecodeError",
  {
    message: Schema.String,
  },
) {}

describe("orchestration cache envelopes", () => {
  it.effect.each([
    ["ASCII", "x", MAX_THREAD_CACHE_BYTES + 1],
    ["UTF-8", "界", Math.floor(MAX_THREAD_CACHE_BYTES / 3) + 1],
  ] as const)("discards oversized %s thread caches before JSON parsing", ([, character, count]) =>
    Effect.gen(function* () {
      using parse = vi.spyOn(JSON, "parse");
      const raw = character.repeat(count);
      let discarded = 0;
      const loaded = yield* decodeOrDiscardOrchestrationCache(
        decodeStoredOrchestrationThreadSnapshot(raw).pipe(Effect.map(Option.some)),
        Effect.sync(() => {
          discarded += 1;
        }),
      );
      expect(Option.isNone(loaded)).toBe(true);
      expect(discarded).toBe(1);
      expect(parse.mock.calls.some(([input]) => input === raw)).toBe(false);
    }),
  );

  it.effect("loads a bounded current thread cache", () =>
    Effect.gen(function* () {
      const snapshot = { snapshotSequence: 4, projection: v2Projection };
      const raw = encodeStoredThreadSnapshotJson({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId: v2ThreadId,
        snapshot,
      });
      const decoded = yield* decodeStoredOrchestrationThreadSnapshot(raw);
      expect(decoded.snapshot).toEqual(snapshot);
    }),
  );

  it("preserves live provider notices through persisted thread snapshots", () => {
    const item = {
      id: TurnItemId.make("notice-cache"),
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    const projection = applyOrchestrationV2ProjectionEvent(v2Projection, {
      id: EventId.make("notice-cache-event"),
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: v2Now,
      payload: item,
    });
    expect(projection).not.toBeNull();
    if (projection === null) throw new Error("Expected live notice projection");
    const encoded = encodeStoredThreadSnapshotJson({
      schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
      environmentId,
      threadId: v2ThreadId,
      snapshot: { snapshotSequence: 5, projection },
    });
    const decoded = decodeStoredThreadSnapshotJson(encoded).snapshot.projection;
    expect(decoded.turnItems.find((entry) => entry.id === item.id)).toEqual(item);
    expect(decoded.visibleTurnItems.find((entry) => entry.item.id === item.id)?.item).toEqual(item);
  });

  it.each([3, 4])("rejects stale thread cache version %s, but not shells", (version) => {
    const staleThread = encodeStoredThreadSnapshotJson({
      schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
      environmentId,
      threadId: v2ThreadId,
      snapshot: { snapshotSequence: 4, projection: v2Projection },
    }).replace(
      `"schemaVersion":${ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION}`,
      `"schemaVersion":${version}`,
    );
    expect(() => decodeStoredThreadSnapshotJson(staleThread)).toThrow();
    const shell = encodeStoredShellSnapshot({
      schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
      environmentId,
      snapshot: v2ShellSnapshot,
    });
    expect(decodeStoredShellSnapshotSync(shell).schemaVersion).toBe(3);
  });

  it.effect("discards V1-versioned cache envelopes after a decode failure", () =>
    Effect.gen(function* () {
      let discardCount = 0;
      const encodedShell = encodeStoredShellSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: v2ShellSnapshot,
      });
      const decoded = Effect.try({
        try: () => decodeStoredShellSnapshotSync({ ...encodedShell, schemaVersion: 1 }),
        catch: (cause) => new TestCacheDecodeError({ message: String(cause) }),
      }).pipe(Effect.map(Option.some));

      const result = yield* decodeOrDiscardOrchestrationCache(
        decoded,
        Effect.sync(() => {
          discardCount += 1;
        }),
      );

      expect(Option.isNone(result)).toBe(true);
      expect(discardCount).toBe(1);
    }),
  );
});
