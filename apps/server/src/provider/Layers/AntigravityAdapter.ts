import {
  ApprovalRequestId,
  type AntigravitySettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import { type AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import {
  buildAntigravityPrintArgs,
  normalizeAntigravityCliEvent,
  normalizeAntigravityProcessExit,
  parseAntigravityEffort,
  parseAntigravityStreamLine,
  type AntigravityEffort,
} from "../antigravity/AntigravityCliProtocol.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");
const ANTIGRAVITY_RESUME_VERSION = 1 as const;

export interface AntigravityAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface ActiveProcess {
  readonly process: ChildProcess.ChildProcess;
  readonly fiber?: Fiber.Fiber<void, unknown>;
}

interface AntigravitySessionContext {
  readonly threadId: ThreadId;
  conversationId?: string;
  session: ProviderSession;
  effort?: AntigravityEffort;
  launchArgs?: string;
  activeTurnId?: TurnId;
  activeProcess?: ActiveProcess;
  interruptedTurnIds: Set<TurnId>;
  abortEmittedTurnIds: Set<TurnId>;
  turns: Array<{ id: TurnId; items: unknown[] }>;
  stopped: boolean;
}

const killProcess = (child: ChildProcess.ChildProcess, signal: NodeJS.Signals = "SIGTERM") => {
  child
    .kill({ killSignal: signal, forceKillAfter: "500 millis" })
    .pipe(Effect.ignore, Effect.runFork);
};

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options: AntigravityAdapterLiveOptions = {},
): Effect.Effect<
  AntigravityAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const adapterScope = yield* Scope.Scope;
    const environment = options.environment ?? process.env;
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("antigravity");

    const randomUUIDv4 = crypto.randomUUIDv4;
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(`evt_${id}`));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const eventHub = yield* PubSub.sliding<ProviderRuntimeEvent>(256);
    const sessionsRef = yield* SynchronizedRef.make(new Map<ThreadId, AntigravitySessionContext>());

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(eventHub, event).pipe(Effect.asVoid);

    const adapter: AntigravityAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "unsupported",
      },

      startSession: (input: ProviderSessionStartInput) =>
        SynchronizedRef.updateEffect(sessionsRef, (map) =>
          Effect.gen(function* () {
            const now = yield* nowIso;
            const initialModel =
              input.modelSelection?.model ?? settings.model ?? "gemini-3.7-flash-high";
            const effort = parseAntigravityEffort(settings.effort);
            const launchArgs = settings.launchArgs?.trim() || undefined;

            const session: ProviderSession = {
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              status: "ready",
              runtimeMode: input.runtimeMode,
              cwd: input.cwd,
              model: initialModel,
              threadId: input.threadId,
              resumeCursor: {
                schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                conversationId: undefined,
              },
              createdAt: now,
              updatedAt: now,
            };

            const ctx: AntigravitySessionContext = {
              threadId: input.threadId,
              conversationId: undefined,
              session,
              effort,
              launchArgs,
              activeTurnId: undefined,
              activeProcess: undefined,
              interruptedTurnIds: new Set(),
              abortEmittedTurnIds: new Set(),
              turns: [],
              stopped: false,
            };

            map.set(input.threadId, ctx);
            return map;
          }),
        ).pipe(
          Effect.flatMap(() =>
            SynchronizedRef.get(sessionsRef).pipe(
              Effect.map((map) => map.get(input.threadId)!.session),
            ),
          ),
        ),

      sendTurn: (input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          const sessions = yield* SynchronizedRef.get(sessionsRef);
          const ctx = sessions.get(input.threadId);
          if (!ctx || ctx.stopped) {
            return yield* Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId: input.threadId,
              }),
            );
          }

          const rawUuid = yield* randomUUIDv4;
          const turnId = TurnId.make(`turn_${rawUuid}`);
          ctx.activeTurnId = turnId;
          ctx.turns.push({ id: turnId, items: [] });

          const promptText = typeof input.input === "string" ? input.input : "";
          const printArgs = buildAntigravityPrintArgs({
            prompt: promptText,
            conversationId: ctx.conversationId,
            model: ctx.session.model,
            effort: ctx.effort,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            launchArgs: ctx.launchArgs,
          });

          const command = settings.binaryPath || "agy";
          const spawnCommand = yield* resolveSpawnCommand(command, printArgs, { env: environment });

          let terminalResultSeen = false;

          const process = yield* spawner
            .spawn(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: ctx.session.cwd,
                env: environment,
                shell: spawnCommand.shell,
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, adapterScope));

          const runFiber = Effect.gen(function* () {
            const linesStream = process.stdout.pipe(Stream.decodeText(), Stream.splitLines);

            yield* Stream.runForEach(linesStream, (line) =>
              Effect.gen(function* () {
                const interrupted = ctx.interruptedTurnIds.has(turnId);
                const parsed = parseAntigravityStreamLine(line);
                const signal = normalizeAntigravityCliEvent(parsed);
                if (!signal) return;

                // After interrupt, ignore mid-turn noise but still surface
                // terminal abort/complete if the CLI emits one first.
                if (
                  interrupted &&
                  signal.type !== "turn.aborted" &&
                  signal.type !== "turn.completed"
                ) {
                  return;
                }
                if (ctx.abortEmittedTurnIds.has(turnId)) {
                  return;
                }

                const stamp = yield* makeEventStamp();

                switch (signal.type) {
                  case "session.started": {
                    ctx.conversationId = signal.conversationId;
                    ctx.session.resumeCursor = {
                      schemaVersion: ANTIGRAVITY_RESUME_VERSION,
                      conversationId: signal.conversationId,
                    };
                    break;
                  }

                  case "content.delta": {
                    yield* offerRuntimeEvent({
                      eventId: stamp.eventId,
                      createdAt: stamp.createdAt,
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: ctx.threadId,
                      turnId,
                      itemId: RuntimeItemId.make(`item_${signal.stepIndex}`),
                      type: "content.delta",
                      payload: {
                        streamKind: "text",
                        delta: signal.text,
                      },
                    } as ProviderRuntimeEvent);
                    break;
                  }

                  case "tool.started": {
                    yield* offerRuntimeEvent({
                      eventId: stamp.eventId,
                      createdAt: stamp.createdAt,
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: ctx.threadId,
                      turnId,
                      itemId: RuntimeItemId.make(`item_tool_${signal.stepIndex}`),
                      type: "item.started",
                      payload: {
                        itemType: "tool_use",
                        status: "running",
                        title: signal.toolName,
                        data: signal.parameters ?? {},
                      },
                    } as ProviderRuntimeEvent);
                    break;
                  }

                  case "tool.completed": {
                    yield* offerRuntimeEvent({
                      eventId: stamp.eventId,
                      createdAt: stamp.createdAt,
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: ctx.threadId,
                      turnId,
                      itemId: RuntimeItemId.make(`item_tool_${signal.stepIndex}`),
                      type: "item.completed",
                      payload: {
                        itemType: "tool_use",
                        status: "completed",
                        title: signal.toolName,
                        data: {
                          output: signal.output,
                          durationSeconds: signal.durationSeconds,
                        },
                      },
                    } as ProviderRuntimeEvent);
                    break;
                  }

                  case "tool.failed": {
                    yield* offerRuntimeEvent({
                      eventId: stamp.eventId,
                      createdAt: stamp.createdAt,
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: ctx.threadId,
                      turnId,
                      itemId: RuntimeItemId.make(`item_tool_${signal.stepIndex}`),
                      type: "item.completed",
                      payload: {
                        itemType: "tool_use",
                        status: "failed",
                        title: signal.toolName,
                        data: {
                          output: signal.output,
                          error: signal.error,
                          status: signal.status,
                          durationSeconds: signal.durationSeconds,
                        },
                      },
                    } as ProviderRuntimeEvent);
                    break;
                  }

                  case "turn.completed": {
                    terminalResultSeen = true;
                    ctx.abortEmittedTurnIds.add(turnId);
                    yield* offerRuntimeEvent({
                      eventId: stamp.eventId,
                      createdAt: stamp.createdAt,
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: ctx.threadId,
                      turnId,
                      type: "turn.completed",
                      payload: {
                        state: "completed",
                        usage: signal.usage,
                      },
                    } as ProviderRuntimeEvent);
                    break;
                  }

                  case "turn.aborted": {
                    terminalResultSeen = true;
                    ctx.abortEmittedTurnIds.add(turnId);
                    yield* offerRuntimeEvent({
                      eventId: stamp.eventId,
                      createdAt: stamp.createdAt,
                      provider: PROVIDER,
                      providerInstanceId: boundInstanceId,
                      threadId: ctx.threadId,
                      turnId,
                      type: "turn.aborted",
                      payload: {
                        reason: signal.response || `Turn aborted with status ${signal.status}`,
                      },
                    } as ProviderRuntimeEvent);
                    break;
                  }
                }
              }),
            );

            const exitStatus = yield* process.exitCode;
            if (!terminalResultSeen && !ctx.abortEmittedTurnIds.has(turnId)) {
              if (ctx.interruptedTurnIds.has(turnId)) {
                ctx.abortEmittedTurnIds.add(turnId);
                const stamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  eventId: stamp.eventId,
                  createdAt: stamp.createdAt,
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: ctx.threadId,
                  turnId,
                  type: "turn.aborted",
                  payload: {
                    reason: "Turn interrupted",
                  },
                } as ProviderRuntimeEvent);
              } else {
                const exitSignal = normalizeAntigravityProcessExit({
                  exitCode: typeof exitStatus === "number" ? exitStatus : null,
                  signal: null,
                  terminalResultSeen,
                });
                if (exitSignal) {
                  ctx.abortEmittedTurnIds.add(turnId);
                  const stamp = yield* makeEventStamp();
                  yield* offerRuntimeEvent({
                    eventId: stamp.eventId,
                    createdAt: stamp.createdAt,
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: ctx.threadId,
                    turnId,
                    type: "turn.aborted",
                    payload: {
                      reason: exitSignal.response || "Process exited unexpectedly",
                    },
                  } as ProviderRuntimeEvent);
                }
              }
            }
          }).pipe(Effect.forkIn(adapterScope));

          const fiber = yield* runFiber;
          ctx.activeProcess = { process, fiber };

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          } satisfies ProviderTurnStartResult;
        }),

      interruptTurn: (threadId: ThreadId, turnId?: TurnId) =>
        Effect.gen(function* () {
          const sessions = yield* SynchronizedRef.get(sessionsRef);
          const ctx = sessions.get(threadId);
          if (!ctx) return;

          const targetTurnId = turnId ?? ctx.activeTurnId;
          if (targetTurnId) {
            ctx.interruptedTurnIds.add(targetTurnId);
          }

          if (ctx.activeProcess) {
            killProcess(ctx.activeProcess.process, "SIGINT");
            if (targetTurnId && !ctx.abortEmittedTurnIds.has(targetTurnId)) {
              ctx.abortEmittedTurnIds.add(targetTurnId);
              const stamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                eventId: stamp.eventId,
                createdAt: stamp.createdAt,
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: ctx.threadId,
                turnId: targetTurnId,
                type: "turn.aborted",
                payload: {
                  reason: "Turn interrupted via SIGINT",
                },
              } as ProviderRuntimeEvent);
            }
            ctx.activeProcess = undefined;
          }
        }),

      // UA-owned approval: turns launch with --dangerously-skip-permissions, so
      // Agy never emits mid-turn permission requests. These remain no-ops; the
      // UA/T3 approval surface must gate before sendTurn instead.
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _decision: ProviderApprovalDecision,
      ) => Effect.void,

      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: ApprovalRequestId,
        _answers: ProviderUserInputAnswers,
      ) => Effect.void,

      stopSession: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const sessions = yield* SynchronizedRef.get(sessionsRef);
          const ctx = sessions.get(threadId);
          if (ctx) {
            ctx.stopped = true;
            if (ctx.activeProcess) {
              killProcess(ctx.activeProcess.process, "SIGTERM");
              ctx.activeProcess = undefined;
            }
            yield* SynchronizedRef.update(sessionsRef, (map) => {
              map.delete(threadId);
              return map;
            });
          }
        }),

      listSessions: () =>
        SynchronizedRef.get(sessionsRef).pipe(
          Effect.map((map) => Array.from(map.values()).map((c) => c.session)),
        ),

      hasSession: (threadId: ThreadId) =>
        SynchronizedRef.get(sessionsRef).pipe(
          Effect.map((map) => map.has(threadId) && !map.get(threadId)!.stopped),
        ),

      readThread: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const sessions = yield* SynchronizedRef.get(sessionsRef);
          const ctx = sessions.get(threadId);
          if (!ctx) {
            return yield* Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              }),
            );
          }
          return {
            threadId,
            turns: ctx.turns.map((t) => ({ id: t.id, items: t.items })),
          };
        }),

      rollbackThread: (threadId: ThreadId, numTurns: number) =>
        Effect.gen(function* () {
          const sessions = yield* SynchronizedRef.get(sessionsRef);
          const ctx = sessions.get(threadId);
          if (!ctx) {
            return yield* Effect.fail(
              new ProviderAdapterSessionNotFoundError({
                provider: PROVIDER,
                threadId,
              }),
            );
          }
          ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
          return {
            threadId,
            turns: ctx.turns.map((t) => ({ id: t.id, items: t.items })),
          };
        }),

      stopAll: () =>
        SynchronizedRef.update(sessionsRef, (map) => {
          for (const ctx of map.values()) {
            ctx.stopped = true;
            if (ctx.activeProcess) {
              ctx.activeProcess.process
                .kill({ killSignal: "SIGTERM", forceKillAfter: "500 millis" })
                .pipe(Effect.ignore, Effect.runFork);
            }
          }
          map.clear();
          return map;
        }),

      streamEvents: Stream.fromPubSub(eventHub),
    };

    return adapter;
  });
}
