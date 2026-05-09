import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
  type VibecodeSettings,
  type ProviderSession,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
} from "@t3tools/contracts";
import { VibecodeClient, type VibecodeAgentMessage } from "@t3tools/vibecode-sdk";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  markActiveVibecodeKeyUsed,
  readVibecodeApiKeyForProvider,
} from "../../vibecode/VibecodeAuthService.ts";
import {
  ensureVibecodeLocalMirror,
  restoreVibecodeRuntimeFromCursor,
  serializeVibecodeResumeCursor,
  upsertVibecodeRuntimeState,
} from "../../vibecode/VibecodeRuntimeService.ts";

const PROVIDER = ProviderDriverKind.make("vibecode");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface VibecodeSessionContext {
  readonly session: ProviderSession;
  vibecodeSessionId?: string | undefined;
  agentUrl?: string | undefined;
  previewUrl?: string | undefined;
  activeTurnId?: TurnId | undefined;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function eventBase(input: {
  readonly threadId: ProviderSession["threadId"];
  readonly turnId?: TurnId | undefined;
  readonly itemId?: RuntimeItemId | undefined;
  readonly instanceId?: ProviderSession["providerInstanceId"] | undefined;
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: EventId.make(`vibecode-event-${crypto.randomUUID()}`),
    provider: PROVIDER,
    ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
    threadId: input.threadId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    createdAt: Effect.runSync(nowIso),
  } as Omit<ProviderRuntimeEvent, "type" | "payload">;
}

function messageTitle(message: VibecodeAgentMessage): string {
  if (message.type === "tool_use") return message.name ? `Tool: ${message.name}` : "Tool use";
  if (message.type === "tool_result")
    return message.name ? `Tool result: ${message.name}` : "Tool result";
  if (message.type === "commit") return message.commitInfo?.summary ?? "Vibecode commit";
  return `Vibecode ${message.type}`;
}

export function makeVibecodeAdapter(input: {
  readonly instanceId?: ProviderSession["providerInstanceId"];
  readonly settings?: VibecodeSettings | undefined;
}): ProviderAdapterShape<ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError> {
  const sessions = new Map<ProviderSession["threadId"], VibecodeSessionContext>();
  const runtimeEvents = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  const configuredBaseUrl = clean(input.settings?.apiBaseUrl);
  const client = new VibecodeClient(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {});

  const requireSession = (threadId: ProviderSession["threadId"]) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      if (!context) {
        throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      return context;
    });

  const offer = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

  const emitMessage = (
    context: VibecodeSessionContext,
    turnId: TurnId,
    message: VibecodeAgentMessage,
  ) => {
    if (message.type === "init") {
      context.vibecodeSessionId = clean(message.init.sessionId);
      upsertVibecodeRuntimeState(context.session.threadId, {
        vibecodeSessionId: context.vibecodeSessionId,
        model: message.init.model || context.session.model,
        remoteWorkspacePath: message.init.workingDir,
        turnStatus: "running",
        message: "Vibecode agent session is configured.",
      });
      return offer({
        ...eventBase({ threadId: context.session.threadId, turnId, instanceId: input.instanceId }),
        type: "session.configured",
        payload: {
          config: {
            cwd: message.init.workingDir || context.session.cwd || "",
            model: message.init.model || context.session.model,
            providerSessionId: context.vibecodeSessionId,
            tools: message.init.tools,
          },
        },
        raw: { source: "codex.eventmsg", messageType: "vibecode.init", payload: message },
      } as ProviderRuntimeEvent);
    }
    if (message.type === "thinking" && message.text.length > 0) {
      return offer({
        ...eventBase({ threadId: context.session.threadId, turnId, instanceId: input.instanceId }),
        type: "content.delta",
        payload: { streamKind: "reasoning_summary_text", delta: message.text },
        raw: { source: "codex.eventmsg", messageType: "vibecode.thinking", payload: message },
      } as ProviderRuntimeEvent);
    }
    if (message.type === "text" && message.text.length > 0) {
      return offer({
        ...eventBase({ threadId: context.session.threadId, turnId, instanceId: input.instanceId }),
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: message.text },
        raw: { source: "codex.eventmsg", messageType: "vibecode.text", payload: message },
      } as ProviderRuntimeEvent);
    }
    if (
      message.type === "tool_use" ||
      message.type === "tool_result" ||
      message.type === "commit"
    ) {
      const itemId = RuntimeItemId.make(`vibecode-item-${message.id ?? crypto.randomUUID()}`);
      return offer({
        ...eventBase({
          threadId: context.session.threadId,
          turnId,
          itemId,
          instanceId: input.instanceId,
        }),
        type: message.type === "tool_use" ? "item.started" : "item.completed",
        payload: {
          itemType: message.type === "commit" ? "file_change" : "dynamic_tool_call",
          status: message.type === "tool_use" ? "inProgress" : "completed",
          title: messageTitle(message),
          data: message,
        },
        raw: {
          source: "codex.eventmsg",
          messageType: `vibecode.${message.type}`,
          payload: message,
        },
      } as ProviderRuntimeEvent);
    }
    if (message.type === "done") {
      context.previewUrl = clean(message.previewUrl ?? undefined);
      upsertVibecodeRuntimeState(context.session.threadId, {
        previewUrl: context.previewUrl,
        ...(context.previewUrl ? { previewSource: "agent_done" } : {}),
        turnStatus: "idle",
        activeTurnId: undefined,
        message: "Vibecode turn completed.",
      });
      return offer({
        ...eventBase({ threadId: context.session.threadId, turnId, instanceId: input.instanceId }),
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: null,
          usage: {
            inputTokens: message.inputTokens,
            outputTokens: message.outputTokens,
            previewUrl: message.previewUrl,
            durationMs: message.durationMs,
          },
        },
        raw: { source: "codex.eventmsg", messageType: "vibecode.done", payload: message },
      } as ProviderRuntimeEvent);
    }
    if (message.type === "error") {
      upsertVibecodeRuntimeState(context.session.threadId, {
        turnStatus: "failed",
        lastError: message.error,
        message: "Vibecode agent returned an error.",
      });
      return offer({
        ...eventBase({ threadId: context.session.threadId, turnId, instanceId: input.instanceId }),
        type: "runtime.error",
        payload: { class: "provider_error", message: message.error },
        raw: { source: "codex.eventmsg", messageType: "vibecode.error", payload: message },
      } as ProviderRuntimeEvent);
    }
    return Effect.void;
  };

  const resolveAgentUrl = async (
    threadId: ProviderSession["threadId"],
  ): Promise<{
    agentUrl: string;
    previewUrl?: string | undefined;
  }> => {
    const directAgentUrl = clean(input.settings?.agentUrl) ?? clean(process.env.VIBECODE_AGENT_URL);
    if (directAgentUrl) {
      upsertVibecodeRuntimeState(threadId, {
        agentUrl: directAgentUrl,
        message: "Using configured Vibecode direct agent URL.",
      });
      return { agentUrl: directAgentUrl };
    }
    const projectId = clean(input.settings?.projectId) ?? clean(process.env.VIBECODE_PROJECT_ID);
    if (!projectId) {
      throw new Error(
        "Configure a Vibecode project ID or direct agent URL in provider settings before sending turns.",
      );
    }
    const apiKey = await readVibecodeApiKeyForProvider(projectId);
    if (!apiKey) throw new Error("Add a valid Vibecode API key before sending with Vibecode.");
    const access = await client.ensureSandboxAccess(apiKey, projectId);
    await markActiveVibecodeKeyUsed();
    const localMirrorPath = await ensureVibecodeLocalMirror(projectId);
    const agentUrl = access.links.agentUrl?.url;
    if (!agentUrl) throw new Error("Vibecode sandbox did not expose an agent URL.");
    upsertVibecodeRuntimeState(threadId, {
      projectId,
      agentUrl,
      sandboxStatus: access.sandbox.status === "running" ? "running" : "unknown",
      ...(localMirrorPath ? { localMirrorPath } : {}),
      ...(access.links.previewUrl?.url
        ? { previewUrl: access.links.previewUrl.url, previewSource: "sandbox_link" }
        : {}),
      message: "Vibecode sandbox is ready.",
    });
    return {
      agentUrl,
      ...(access.links.previewUrl?.url ? { previewUrl: access.links.previewUrl.url } : {}),
    };
  };

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: (sessionInput: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        restoreVibecodeRuntimeFromCursor(sessionInput.threadId, sessionInput.resumeCursor);
        const session: ProviderSession = {
          provider: PROVIDER,
          ...(input.instanceId ? { providerInstanceId: input.instanceId } : {}),
          status: "ready",
          runtimeMode: sessionInput.runtimeMode,
          ...(sessionInput.cwd ? { cwd: sessionInput.cwd } : {}),
          ...(sessionInput.modelSelection?.model
            ? { model: sessionInput.modelSelection.model }
            : {}),
          threadId: sessionInput.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        sessions.set(session.threadId, { session });
        upsertVibecodeRuntimeState(session.threadId, {
          model: session.model,
          turnStatus: "idle",
          message: "Vibecode session is ready.",
        });
        return session;
      }),
    sendTurn: (turnInput: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const context = yield* requireSession(turnInput.threadId);
        const id = yield* Random.nextUUIDv4;
        const turnId = TurnId.make(`vibecode-turn-${id}`);
        context.activeTurnId = turnId;
        const model = turnInput.modelSelection?.model ?? context.session.model ?? "vibecode-auto";
        const prompt = turnInput.input?.trim();
        if (!prompt) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Vibecode turns require text input.",
          });
        }
        upsertVibecodeRuntimeState(turnInput.threadId, {
          activeTurnId: turnId,
          model,
          turnStatus: "running",
          message: "Vibecode turn is running.",
          lastError: undefined,
        });
        yield* offer({
          ...eventBase({ threadId: turnInput.threadId, turnId, instanceId: input.instanceId }),
          type: "turn.started",
          payload: { model },
        } as ProviderRuntimeEvent);

        const runTurn = Effect.tryPromise({
          try: async () => {
            try {
              const resolved = await resolveAgentUrl(turnInput.threadId);
              context.agentUrl = resolved.agentUrl;
              if (resolved.previewUrl) context.previewUrl = resolved.previewUrl;
              upsertVibecodeRuntimeState(turnInput.threadId, {
                agentUrl: resolved.agentUrl,
                ...(resolved.previewUrl
                  ? { previewUrl: resolved.previewUrl, previewSource: "sandbox_link" }
                  : {}),
                turnStatus: "running",
                message: "Connected to Vibecode agent.",
              });
              for await (const message of client.dispatchAgent({
                agentUrl: resolved.agentUrl,
                prompt,
                model,
                agent: "vibecode",
                maxTurns: 100,
                sessionId: context.vibecodeSessionId,
                reasoningEffort: model.includes("pro") ? "high" : undefined,
                plan: turnInput.interactionMode === "plan",
              })) {
                await Effect.runPromise(emitMessage(context, turnId, message));
              }
            } catch (error) {
              await Effect.runPromise(
                offer({
                  ...eventBase({
                    threadId: turnInput.threadId,
                    turnId,
                    instanceId: input.instanceId,
                  }),
                  type: "turn.completed",
                  payload: {
                    state: "failed",
                    stopReason: "error",
                    errorMessage: error instanceof Error ? error.message : "Vibecode turn failed.",
                  },
                } as ProviderRuntimeEvent),
              );
              upsertVibecodeRuntimeState(turnInput.threadId, {
                turnStatus: "failed",
                lastError: error instanceof Error ? error.message : "Vibecode turn failed.",
                message: "Vibecode turn failed.",
              });
            } finally {
              context.activeTurnId = undefined;
            }
          },
          catch: (error) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: error instanceof Error ? error.message : "Vibecode turn failed.",
              cause: error,
            }),
        });
        yield* runTurn.pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

        return {
          threadId: turnInput.threadId,
          turnId,
          resumeCursor: serializeVibecodeResumeCursor(turnInput.threadId),
        };
      }),
    interruptTurn: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          Effect.promise(async () => {
            if (context.agentUrl) await client.stopAgent(context.agentUrl);
          }),
        ),
      ),
    respondToRequest: (threadId) => requireSession(threadId).pipe(Effect.asVoid),
    respondToUserInput: (threadId) => requireSession(threadId).pipe(Effect.asVoid),
    stopSession: (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map(() => ({ threadId, turns: [] }))),
    rollbackThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map(() => ({ threadId, turns: [] }))),
    stopAll: () =>
      Effect.sync(() => {
        sessions.clear();
      }),
    get streamEvents() {
      return Stream.fromQueue(runtimeEvents);
    },
  };
}
