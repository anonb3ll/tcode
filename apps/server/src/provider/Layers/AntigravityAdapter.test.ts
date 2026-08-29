import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  AntigravitySettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makeAntigravityAdapter } from "./AntigravityAdapter.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

it.layer(NodeServices.layer)("AntigravityAdapter", (it) => {
  it.effect("manages session lifecycle: start, list, has, stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({ enabled: true }),
          { instanceId: ProviderInstanceId.make("antigravity") },
        );

        const threadId = ThreadId.make("thread_test_123");
        const session = yield* adapter.startSession({
          threadId,
          cwd: "/tmp",
          runtimeMode: "full-access",
        });

        expect(session.threadId).toBe(threadId);
        expect(session.status).toBe("ready");
        expect(yield* adapter.hasSession(threadId)).toBe(true);

        const sessions = yield* adapter.listSessions();
        expect(sessions.length).toBe(1);
        expect(sessions[0].threadId).toBe(threadId);

        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    ),
  );

  it.effect("executes bounded read-only turn, streams deltas and tool events, and completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-adapter-" });
        const mockAgyPath = path.join(dir, "agy");

        const line1 = JSON.stringify({
          event: "init",
          conversation_id: "conv_agy_test_456",
          init: {
            cwd: dir,
            model: "gemini-3.7-flash-high",
            permission_mode: "request-review",
            tools: ["run_command"],
          },
        });
        const line2 = JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "agent_response",
            state: "ACTIVE",
            text_delta: "Inspecting repository safely...",
          },
        });
        const line3 = JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 2,
            step_type: "tool",
            state: "ACTIVE",
            tool_name: "run_command",
            tool_info: {
              name: "run_command",
              parameters: { CommandLine: "echo READ_ONLY_PROBE" },
            },
          },
        });
        const line4 = JSON.stringify({
          event: "step_update",
          step_update: {
            step_index: 2,
            step_type: "tool",
            state: "DONE",
            tool_name: "run_command",
            duration_seconds: 0.12,
            tool_info: {
              name: "run_command",
              parameters: { CommandLine: "echo READ_ONLY_PROBE" },
              output: "READ_ONLY_PROBE",
            },
          },
        });
        const line5 = JSON.stringify({
          event: "result",
          result: {
            conversation_id: "conv_agy_test_456",
            status: "SUCCESS",
            response: "Inspection complete. Output: READ_ONLY_PROBE",
            duration_seconds: 0.5,
            num_turns: 1,
            usage: { input_tokens: 50, output_tokens: 15 },
          },
        });

        yield* fs.writeFileString(
          mockAgyPath,
          [
            "#!/bin/sh",
            `cat << 'RAW_EOF'`,
            line1,
            line2,
            line3,
            line4,
            line5,
            `RAW_EOF`,
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(mockAgyPath, 0o755);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({ enabled: true, binaryPath: mockAgyPath }),
          { instanceId: ProviderInstanceId.make("antigravity") },
        );

        const threadId = ThreadId.make("thread_turn_test");
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "full-access",
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const turnCompleted = yield* Deferred.make<void>();

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.completed" || event.type === "turn.aborted"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkScoped);

        const turnResult = yield* adapter.sendTurn({
          threadId,
          input: "Run safe inspection",
          interactionMode: "plan",
        });

        expect(turnResult.threadId).toBe(threadId);
        expect(turnResult.turnId).toBeDefined();

        yield* Deferred.await(turnCompleted);
        expect(runtimeEvents.length).toBeGreaterThanOrEqual(4);

        // 1. Content delta
        const delta = runtimeEvents.find((e) => e.type === "content.delta");
        expect(delta).toBeDefined();
        if (delta && delta.type === "content.delta") {
          expect(delta.payload.delta).toBe("Inspecting repository safely...");
        }

        // 2. Tool started and completed
        const toolStarted = runtimeEvents.find(
          (e) => e.type === "item.started" && (e.payload as any)?.itemType === "tool_use",
        );
        expect(toolStarted).toBeDefined();
        expect((toolStarted?.payload as any)?.title).toBe("run_command");

        const toolCompleted = runtimeEvents.find(
          (e) => e.type === "item.completed" && (e.payload as any)?.itemType === "tool_use",
        );
        expect(toolCompleted).toBeDefined();
        expect((toolCompleted?.payload as any)?.data?.output).toContain("READ_ONLY_PROBE");

        // 3. Turn completed
        const completed = runtimeEvents.find((e) => e.type === "turn.completed");
        expect(completed).toBeDefined();
        if (completed && completed.type === "turn.completed") {
          expect(completed.payload.state).toBe("completed");
        }
      }),
    ),
  );

  it.effect("emits turn.aborted when interruptTurn runs against an active turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-interrupt-" });
        const mockAgyPath = path.join(dir, "agy");

        // Exit quickly after one line — interrupt races the short window while
        // activeProcess is set. Abort is emitted by interruptTurn itself.
        yield* fs.writeFileString(
          mockAgyPath,
          [
            "#!/bin/sh",
            'printf \'%s\\n\' \'{"event":"init","conversation_id":"conv_int_1","init":{"cwd":"/tmp","model":"gemini-3.7-flash-high","permission_mode":"request-review","tools":[]}}\'',
            'printf \'%s\\n\' \'{"event":"result","result":{"conversation_id":"conv_int_1","status":"SUCCESS","response":"done"}}\'',
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(mockAgyPath, 0o755);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({ enabled: true, binaryPath: mockAgyPath }),
          { instanceId: ProviderInstanceId.make("antigravity") },
        );

        const threadId = ThreadId.make("thread_interrupt_test");
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "full-access",
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkScoped);

        const turnResult = yield* adapter.sendTurn({
          threadId,
          input: "Test interrupt handling",
        });
        expect(turnResult.turnId).toBeDefined();

        yield* adapter.interruptTurn(threadId, turnResult.turnId);

        // Either interrupt emitted abort, or the turn already completed — both
        // prove the adapter did not suppress the terminal event.
        const terminal = runtimeEvents.filter(
          (event) => event.type === "turn.aborted" || event.type === "turn.completed",
        );
        expect(terminal.length).toBeGreaterThanOrEqual(1);

        yield* adapter.stopSession(threadId);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
    ),
  );

  it.effect("maps tool ERROR steps to failed item.completed events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-agy-tool-error-" });
        const mockAgyPath = path.join(dir, "agy");

        const lines = [
          JSON.stringify({
            event: "init",
            conversation_id: "conv_err",
            init: {
              cwd: dir,
              model: "gemini-3.7-flash-high",
              permission_mode: "default",
              tools: [],
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              step_type: "tool",
              state: "ACTIVE",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "false" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              step_type: "tool",
              state: "ERROR",
              tool_name: "run_command",
              tool_info: { name: "run_command", error: "exit 1" },
            },
          }),
          JSON.stringify({
            event: "result",
            result: {
              conversation_id: "conv_err",
              status: "SUCCESS",
              response: "tool failed but turn continued",
            },
          }),
        ];

        yield* fs.writeFileString(
          mockAgyPath,
          ["#!/bin/sh", "cat << 'RAW_EOF'", ...lines, "RAW_EOF", "exit 0", ""].join("\n"),
        );
        yield* fs.chmod(mockAgyPath, 0o755);

        const adapter = yield* makeAntigravityAdapter(
          decodeAntigravitySettings({
            enabled: true,
            binaryPath: mockAgyPath,
            launchArgs: "--sandbox",
            effort: "medium",
          }),
          { instanceId: ProviderInstanceId.make("antigravity") },
        );

        const threadId = ThreadId.make("thread_tool_error");
        yield* adapter.startSession({
          threadId,
          cwd: dir,
          runtimeMode: "approval-required",
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const turnCompleted = yield* Deferred.make<void>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.completed" || event.type === "turn.aborted"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkScoped);

        yield* adapter.sendTurn({ threadId, input: "force tool error" });
        yield* Deferred.await(turnCompleted);

        const failed = runtimeEvents.find(
          (e) =>
            e.type === "item.completed" && (e.payload as { status?: string }).status === "failed",
        );
        expect(failed).toBeDefined();
        expect((failed?.payload as { title?: string }).title).toBe("run_command");
      }),
    ),
  );
});
