import { expect, it } from "@effect/vitest";
import {
  CommandId, EventId, MessageId, ProjectId, ProviderDriverKind, ProviderInstanceId,
  ProviderThreadId, ProviderSessionId, RunId, ThreadId, ContextHandoffId, TurnItemId,
  type OrchestrationV2AppThread, type OrchestrationV2ProviderThread,
  type OrchestrationV2DomainEvent, type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Recovery from "./NativeBindingRecovery.ts";

const database = Sqlite.layerMemory;
const stores = Layer.mergeAll(
  EventStore.layer, ProjectionStore.layer,
).pipe(Layer.provideMerge(database));
const layer = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provide(stores)),
  stores,
  ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
  IdAllocator.layer,
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
    hasOwnedThreadWork: () => Effect.succeed(false),
  }),
);
const fixture = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("binding-recovery");
  const providerThreadId = ProviderThreadId.make("binding-recovery-provider");
  const instanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId, model: "test" };
  const thread: OrchestrationV2AppThread = {
    id: threadId, projectId: ProjectId.make("binding-project"), title: "Recovery",
    providerInstanceId: instanceId, modelSelection, runtimeMode: "full-access",
    interactionMode: "default", branch: null, worktreePath: null,
    activeProviderThreadId: providerThreadId, createdBy: "user", creationSource: "web",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null, createdAt: now, updatedAt: now, archivedAt: null,
    settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
  };
  const original: OrchestrationV2ProviderThread = {
    id: providerThreadId, driver: ProviderDriverKind.make("codex"), providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("binding-session"), appThreadId: threadId,
    ownerNodeId: null, nativeThreadRef: { driver: ProviderDriverKind.make("codex"),
      nativeId: "original-with-goal", strength: "strong" }, nativeConversationHeadRef: null,
    status: "idle", firstRunOrdinal: 1, lastRunOrdinal: 1, handoffIds: [], forkedFrom: null,
    goal: { objective: "Preserve me", status: "active", tokensUsed: 1234, timeUsedSeconds: 56 },
    nativeMetadata: { itemIdentityVersion: 2 }, createdAt: now, updatedAt: now,
  };
  const current = { ...original, goal: null,
    nativeThreadRef: { ...original.nativeThreadRef!, nativeId: "replacement" } };
  let index = 0;
  const write = (value: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">) =>
    sink.write({ events: [{ ...value, id: EventId.make(`binding-event-${++index}`),
      threadId, occurredAt: now } as OrchestrationV2DomainEvent] });
  yield* write({ type: "thread.created", payload: thread });
  const [proof] = yield* write({ type: "provider-thread.updated", payload: original });
  yield* write({ type: "provider-thread.updated", payload: current });
  const runId = RunId.make("replacement-run");
  const run = { id: runId, threadId, ordinal: 2, providerInstanceId: instanceId, modelSelection,
    providerThreadId, userMessageId: MessageId.make("replacement-message"), rootNodeId: null,
    activeAttemptId: null, status: "completed" as const, requestedAt: now, startedAt: now,
    completedAt: now, checkpointId: null, contextHandoffId: null };
  yield* write({ type: "run.created", payload: run });
  yield* write({ type: "context-handoff.updated", payload: {
    id: ContextHandoffId.make("old-uncertain"), threadId, targetRunId: runId,
    fromProviderThreadIds: [providerThreadId], toProviderThreadId: providerThreadId,
    coveredRunOrdinals: { from: 1, to: 1 }, strategy: "full_thread_summary", status: "ready",
    summaryMessageId: null, summaryText: "Uncertain old history", createdByProviderInstanceId: instanceId,
    delivery: { nativeThreadId: "original-with-goal", status: "pending", itemIds: [] },
    createdAt: now, updatedAt: now,
  } });
  yield* write({ type: "turn-item.updated", payload: {
    id: TurnItemId.make("replacement-answer"), threadId, runId, nodeId: null,
    providerThreadId, providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 1,
    status: "completed", title: null, startedAt: now, completedAt: now, updatedAt: now,
    type: "assistant_message", messageId: MessageId.make("replacement-answer"),
    text: "New conversation after replacement", streaming: false,
  } });
  const command = { type: "provider-thread.recover-native" as const,
    commandId: CommandId.make("recover-binding"), threadId, providerThreadId,
    expectedNativeThreadRef: current.nativeThreadRef, priorBindingSequence: proof!.sequence,
    expectedSequence: yield* sink.latestSequence({ threadId }), acknowledgeUncertainHistory: true as const,
  } satisfies OrchestrationV2Command;
  const commit = (plan: Effect.Success<ReturnType<typeof Recovery.prepare>>) =>
    sink.commitCommand({ ...command, commandType: command.type, acceptedAt: now,
      events: plan.events, effects: [], nativeRecovery: plan.nativeRecovery });
  return { sink, store, original, current, command, commit, write, run, now, thread };
});

it.effect("rejects a historical native ref owned by another provider thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* Recovery.prepare(f.command);
    yield* f.sink.write({ events: [{ id: EventId.make("foreign-thread-created"),
      type: "thread.created", threadId: ThreadId.make("foreign-thread"), occurredAt: f.now,
      payload: { ...f.thread, id: ThreadId.make("foreign-thread"), activeProviderThreadId: null },
    }, { id: EventId.make("foreign-native-owner"),
      type: "provider-thread.updated", threadId: ThreadId.make("foreign-thread"), occurredAt: f.now,
      payload: { ...f.original, id: ProviderThreadId.make("foreign-provider"),
        appThreadId: ThreadId.make("foreign-thread") },
    }] });
    expect((yield* f.commit(plan).pipe(Effect.flip))._tag).toBe("EventSinkWriteError");
    const rows = yield* f.store.getThreadRecords(f.command.threadId, ["providerThreads"]);
    expect(rows.providerThreads[0]?.nativeThreadRef).toEqual(f.current.nativeThreadRef);
  }).pipe(Effect.provide(layer)),
);

it.effect("does not rebind a provider that still reports owned work", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const failed = yield* Recovery.prepare(f.command).pipe(
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        hasOwnedThreadWork: () => Effect.succeed(true),
      } as ProviderSessionManager.ProviderSessionManagerV2Shape), Effect.flip,
    );
    expect(failed).toMatchObject({ reason: "provider still owns thread work" });
  }).pipe(Effect.provide(layer)),
);

it.effect("recovers a proven binding without confirming uncertain delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* Recovery.prepare(f.command);
    yield* f.commit(plan);
    const rows = yield* f.store.getThreadRecords(f.command.threadId, ["providerThreads", "contextHandoffs", "turnItems"]);
    expect(rows.providerThreads[0]?.nativeThreadRef).toEqual(f.original.nativeThreadRef);
    expect(rows.providerThreads[0]?.goal).toEqual(f.original.goal);
    expect(rows.providerThreads[0]?.nativeMetadata).toEqual(f.original.nativeMetadata);
    const old = rows.contextHandoffs.find((row) => row.id === "old-uncertain");
    expect(old).toMatchObject({ status: "superseded", delivery: { status: "pending" } });
    const next = rows.contextHandoffs.find((row) => row.resumeOnNativeThreadId !== undefined);
    expect(next?.delivery).toBeUndefined();
    expect(next?.resumeOnNativeThreadId).toBe("original-with-goal");
    expect(next?.history?.messages.some((message) => message.text.includes("New conversation after replacement"))).toBe(true);
    expect(rows.turnItems.some((item) => item.title === "Native binding recovered; resume pending")).toBe(true);
    const replay = yield* f.commit(plan);
    expect(replay.committed).toBe(false);
  }).pipe(Effect.provide(layer)),
);

for (const field of ["expectedSequence", "priorBindingSequence", "expectedNativeThreadRef"] as const) {
  it.effect(`refuses recovery with mismatched ${field}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const command = { ...f.command,
        ...(field === "expectedSequence" ? { expectedSequence: 0 } : {}),
        ...(field === "priorBindingSequence" ? { priorBindingSequence: 1 } : {}),
        ...(field === "expectedNativeThreadRef" ? { expectedNativeThreadRef: f.original.nativeThreadRef! } : {}),
      };
      expect((yield* Recovery.prepare(command).pipe(Effect.flip))._tag).toBe("NativeBindingRecoveryError");
      expect(yield* f.sink.latestSequence({ threadId: command.threadId })).toBe(f.command.expectedSequence);
    }).pipe(Effect.provide(layer)),
  );
}

it.effect("refuses to recover while a queued run owns the thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.write({ type: "run.updated", payload: { ...f.run, status: "queued" } });
    const command = { ...f.command, expectedSequence: yield* f.sink.latestSequence({ threadId: f.command.threadId }) };
    expect(yield* Recovery.prepare(command).pipe(Effect.flip)).toMatchObject({ reason: "thread still owns pending work" });
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses an update racing the recovery commit", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const plan = yield* Recovery.prepare(f.command);
    yield* f.write({ type: "provider-thread.updated", payload: { ...f.current, status: "active" } });
    expect((yield* f.commit(plan).pipe(Effect.flip))._tag).toBe("EventSinkWriteError");
    const rows = yield* f.store.getThreadRecords(f.command.threadId, ["providerThreads", "contextHandoffs"]);
    expect(rows.providerThreads[0]?.nativeThreadRef).toEqual(f.current.nativeThreadRef);
    expect(rows.contextHandoffs).toHaveLength(1);
    expect(rows.contextHandoffs[0]?.status).toBe("ready");
  }).pipe(Effect.provide(layer)),
);

it.effect("reconciles a pending handoff on the original binding without reducing cached usage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const current = { ...f.original, goal: { ...f.original.goal!, tokensUsed: 5678 } };
    yield* f.write({ type: "provider-thread.updated", payload: current });
    const command = { ...f.command, expectedNativeThreadRef: current.nativeThreadRef!,
      expectedSequence: yield* f.sink.latestSequence({ threadId: f.command.threadId }) };
    const plan = yield* Recovery.prepare(command);
    yield* f.sink.commitCommand({ ...command, commandType: command.type, acceptedAt: f.now,
      events: plan.events, effects: [], nativeRecovery: plan.nativeRecovery });
    const rows = yield* f.store.getThreadRecords(command.threadId, ["providerThreads", "contextHandoffs"]);
    expect(rows.providerThreads[0]?.goal?.tokensUsed).toBe(5678);
    expect(rows.contextHandoffs.find((row) => row.id === "old-uncertain")).toMatchObject({
      status: "superseded", delivery: { status: "pending" },
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("atomically refuses recovery while a pending effect still owns the thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const commandId = CommandId.make("pending-start");
    yield* f.sink.commitCommand({ commandId, threadId: f.command.threadId,
      commandType: "message.dispatch", acceptedAt: f.now, events: [{
        id: EventId.make("pending-effect-setup"), type: "provider-thread.updated",
        threadId: f.command.threadId, occurredAt: f.now, payload: f.current,
      }], effects: [{
        id: "pending-start-effect", commandId, threadId: f.command.threadId,
        request: { type: "provider-turn.start", runId: f.run.id },
      }] });
    const plan = yield* Recovery.prepare({ ...f.command,
      expectedSequence: yield* f.sink.latestSequence({ threadId: f.command.threadId }),
    });
    expect((yield* f.commit(plan).pipe(Effect.flip))._tag).toBe("EventSinkWriteError");
    const rows = yield* f.store.getThreadRecords(f.command.threadId, ["providerThreads", "contextHandoffs"]);
    expect(rows.providerThreads[0]?.nativeThreadRef).toEqual(f.current.nativeThreadRef);
    expect(rows.contextHandoffs[0]?.status).toBe("ready");
  }).pipe(Effect.provide(layer)),
);
