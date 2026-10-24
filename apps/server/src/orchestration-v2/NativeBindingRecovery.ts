import {
  OrchestrationV2ProviderRef,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class NativeBindingRecoveryError extends Schema.TaggedError<NativeBindingRecoveryError>()(
  "NativeBindingRecoveryError", { reason: Schema.String },
) {
  override get message() { return `Native binding recovery refused: ${this.reason}`; }
}

const sameRef = Schema.toEquivalence(OrchestrationV2ProviderRef);
const busy = new Set(["queued", "preparing", "pending", "starting", "running", "waiting"]);
type RecoveryCommand = Extract<OrchestrationV2Command, { type: "provider-thread.recover-native" }>;

/** Plans only. The command owner commits the complete batch with a sequence guard. */
export const prepare = Effect.fn("NativeBindingRecovery.prepare")(function* (command: RecoveryCommand) {
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const handoffs = yield* ContextHandoffService.ContextHandoffServiceV2;
  if ((yield* sink.latestSequence({ threadId: command.threadId })) !== command.expectedSequence) {
    return yield* new NativeBindingRecoveryError({ reason: "stale thread snapshot" });
  }
  const projection = yield* store.getRuntimeRecoveryProjection(command.threadId);
  // Runtime recovery omits idle bindings and completed runs.
  const records = yield* store.getThreadRecords(command.threadId, [
    "providerThreads", "contextHandoffs", "runs", "providerTurns",
  ]);
  const current = records.providerThreads.find((row) => row.id === command.providerThreadId);
  if (current === undefined || current.driver !== "codex" || current.ownerNodeId !== null ||
      current.appThreadId !== command.threadId || current.nativeThreadRef === null ||
      projection.thread.activeProviderThreadId !== current.id ||
      projection.thread.providerInstanceId !== current.providerInstanceId ||
      !sameRef(current.nativeThreadRef, command.expectedNativeThreadRef)) {
    return yield* new NativeBindingRecoveryError({ reason: "current native binding differs" });
  }
  if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null ||
      projection.thread.lineage.relationshipToParent === "subagent" ||
      !["idle", "error", "not_loaded"].includes(current.status) ||
      [...projection.runs, ...projection.attempts, ...projection.nodes,
        ...projection.subagents, ...records.providerTurns, ...projection.runtimeRequests,
        ...projection.turnItems].some((row) => busy.has(row.status)) ||
      projection.providerThreads.some((row) => row.status === "active" ||
        (row.pendingBackgroundTasks?.length ?? 0) > 0)) {
    return yield* new NativeBindingRecoveryError({ reason: "thread still owns pending work" });
  }
  const evidence = yield* sink.readAtSequence({
    threadId: command.threadId, sequence: command.priorBindingSequence,
  });
  const event = Option.getOrUndefined(evidence)?.event;
  if (command.priorBindingSequence >= command.expectedSequence ||
      event?.type !== "provider-thread.updated" || event.threadId !== command.threadId ||
      event.payload.id !== current.id || event.payload.appThreadId !== command.threadId ||
      event.payload.providerInstanceId !== current.providerInstanceId ||
      event.payload.driver !== current.driver || event.payload.ownerNodeId !== null || event.payload.goal == null ||
      event.payload.nativeThreadRef?.strength !== "strong" ||
      event.payload.nativeThreadRef.driver !== current.driver) {
    return yield* new NativeBindingRecoveryError({ reason: "prior binding is not proven" });
  }
  const restoredRef = event.payload.nativeThreadRef;
  const sameNative = sameRef(restoredRef, current.nativeThreadRef);
  if (!sameNative && current.goal != null) {
    return yield* new NativeBindingRecoveryError({ reason: "current binding also has a goal" });
  }
  if (current.providerSessionId !== null &&
      ((yield* sessions.hasOwnedThreadWork(current.providerSessionId, current)) ||
       (yield* sessions.hasOwnedThreadWork(current.providerSessionId, {
         ...current, nativeThreadRef: restoredRef,
       })))) {
    return yield* new NativeBindingRecoveryError({ reason: "provider still owns thread work" });
  }
  const latestRun = records.runs.at(-1);
  if (latestRun === undefined) {
    return yield* new NativeBindingRecoveryError({ reason: "no retained run for recovery context" });
  }
  const now = yield* DateTime.now;
  const providerThread = {
    ...current, nativeThreadRef: restoredRef, nativeConversationHeadRef: null,
    contextUsage: null,
    nativeMetadata: sameNative ? (current.nativeMetadata ?? event.payload.nativeMetadata) : event.payload.nativeMetadata,
    goal: sameNative ? (current.goal ?? event.payload.goal) : event.payload.goal,
    status: "idle" as const, updatedAt: now,
  };
  const superseded = records.contextHandoffs.filter((handoff) =>
    handoff.toProviderThreadId === current.id && handoff.status !== "superseded" &&
    handoff.delivery?.nativeThreadId === restoredRef.nativeId && handoff.delivery.status === "pending",
  );
  if (sameNative && superseded.length === 0) {
    return yield* new NativeBindingRecoveryError({ reason: "binding is already current without uncertain delivery" });
  }
  const recovered = yield* handoffs.prepareProviderHandoff({
    threadId: command.threadId, targetRunId: latestRun.id, transferId: null,
    fromProviderThreadIds: [current.id], toProviderThreadId: current.id,
    fromProviderInstanceId: current.providerInstanceId, toProviderInstanceId: current.providerInstanceId,
    coveredRunOrdinals: { from: 1, to: latestRun.ordinal }, strategy: "full_thread_summary",
    items: yield* store.getTurnStartHistory(command.threadId), createdAt: now,
  });
  const notice = `Recovered native binding from event ${command.priorBindingSequence}: ` +
    `${current.nativeThreadRef.nativeId} -> ${restoredRef.nativeId}. ` +
    `Superseded ${superseded.length} uncertain delivery attempts without confirming injection. ` +
    "Goal and native metadata are last-observed projections; native goal data was not changed. " +
    "Conversation is retained as historical context; do not replay tool calls.";
  const events: OrchestrationV2DomainEvent[] = [];
  const append = Effect.fn("NativeBindingRecovery.append")(function* (
    value: Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">,
  ) {
      events.push({ ...value, id: yield* ids.allocate.event({
        threadId: command.threadId, commandId: command.commandId,
      }), threadId: command.threadId, occurredAt: now } as OrchestrationV2DomainEvent);
    });
  yield* append({ type: "provider-thread.updated", payload: providerThread });
  for (const handoff of superseded) {
    yield* append({ type: "context-handoff.updated",
      payload: { ...handoff, status: "superseded", updatedAt: now } });
  }
  yield* append({ type: "context-handoff.updated", payload: {
    ...recovered, resumeOnNativeThreadId: restoredRef.nativeId,
    history: recovered.history === undefined ? undefined : {
      ...recovered.history, coverage: `${notice}\n${recovered.history.coverage}`,
    },
  } });
  yield* append({ type: "turn-item.updated", payload: {
    id: TurnItemId.make(`native-binding-recovery:${command.commandId}`),
    threadId: command.threadId, runId: null, nodeId: null,
    providerThreadId: current.id, providerTurnId: null, nativeItemRef: null, parentItemId: null,
    ordinal: yield* store.getNextTurnItemOrdinal(command.threadId), status: "completed",
    title: "Native binding recovered; resume pending", startedAt: now, completedAt: now,
    updatedAt: now, type: "command_execution", input: command.type, output: notice, exitCode: 0,
  } });
  return {
    events,
    nativeRecovery: { expectedSequence: command.expectedSequence, providerThread },
  };
});
