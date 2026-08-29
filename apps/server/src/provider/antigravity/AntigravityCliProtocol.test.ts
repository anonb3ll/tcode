import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildAntigravityPrintArgs,
  classifyAntigravityAvailability,
  normalizeAntigravityCliEvent,
  normalizeAntigravityProcessExit,
  parseAntigravityEffort,
  parseAntigravityStreamLine,
  resolveAntigravityCliMode,
} from "./AntigravityCliProtocol.ts";

describe("buildAntigravityPrintArgs", () => {
  it("builds a UA-owned-approval stream-json launch without fake sandbox", () => {
    NodeAssert.deepStrictEqual(
      buildAntigravityPrintArgs({
        prompt: "Inspect the repository without changing files.",
        model: "gemini-3.7-flash-low",
        effort: "low",
        interactionMode: "plan",
      }),
      [
        "--print",
        "Inspect the repository without changing files.",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--dangerously-skip-permissions",
        "--model",
        "gemini-3.7-flash-low",
        "--effort",
        "low",
      ],
    );
  });

  it("maps default interaction to accept-edits and appends launchArgs", () => {
    NodeAssert.deepStrictEqual(
      buildAntigravityPrintArgs({
        prompt: "Continue the inspection.",
        conversationId: "conversation-123",
        runtimeMode: "full-access",
        launchArgs: "--sandbox --add-dir /tmp/extra",
      }),
      [
        "--print",
        "Continue the inspection.",
        "--output-format",
        "stream-json",
        "--mode",
        "accept-edits",
        "--dangerously-skip-permissions",
        "--conversation",
        "conversation-123",
        "--sandbox",
        "--add-dir",
        "/tmp/extra",
      ],
    );
  });

  it("drops invalid effort literals", () => {
    NodeAssert.equal(parseAntigravityEffort("ultrathink"), undefined);
    NodeAssert.equal(parseAntigravityEffort("low"), "low");
    NodeAssert.equal(resolveAntigravityCliMode({ interactionMode: "plan" }), "plan");
    NodeAssert.equal(
      resolveAntigravityCliMode({ runtimeMode: "approval-required" }),
      "accept-edits",
    );
  });
});

describe("Antigravity stream-json protocol", () => {
  it("normalizes session initialization", () => {
    const event = parseAntigravityStreamLine(
      JSON.stringify({
        event: "init",
        conversation_id: "conversation-123",
        init: {
          model: "gemini-3.7-flash-low",
          cwd: "/workspace",
          permission_mode: "request-review",
          tools: [],
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(event), {
      type: "session.started",
      conversationId: "conversation-123",
      model: "gemini-3.7-flash-low",
      cwd: "/workspace",
      permissionMode: "request-review",
    });
  });

  it("normalizes assistant text deltas", () => {
    const event = parseAntigravityStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "AGY_OK",
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(event), {
      type: "content.delta",
      stepIndex: 1,
      text: "AGY_OK",
    });
  });

  it("normalizes tool step execution events including ERROR", () => {
    const activeEvent = parseAntigravityStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo PROBE_TEST" },
          },
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(activeEvent), {
      type: "tool.started",
      stepIndex: 2,
      toolName: "run_command",
      parameters: { CommandLine: "echo PROBE_TEST" },
    });

    const doneEvent = parseAntigravityStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          duration_seconds: 0.189,
          tool_info: {
            name: "run_command",
            parameters: { CommandLine: "echo PROBE_TEST" },
            output: "PROBE_TEST\r\n",
          },
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(doneEvent), {
      type: "tool.completed",
      stepIndex: 2,
      toolName: "run_command",
      durationSeconds: 0.189,
      output: "PROBE_TEST\r\n",
    });

    const errorEvent = parseAntigravityStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 3,
          step_type: "tool",
          state: "ERROR",
          tool_name: "run_command",
          tool_info: {
            name: "run_command",
            error: "permission denied",
          },
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(errorEvent), {
      type: "tool.failed",
      stepIndex: 3,
      toolName: "run_command",
      status: "ERROR",
      error: "permission denied",
    });
  });

  it("normalizes terminal results and CANCELED taxonomy", () => {
    const event = parseAntigravityStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-123",
          status: "SUCCESS",
          response: "AGY_OK\n",
          duration_seconds: 0.806,
          num_turns: 1,
          usage: { input_tokens: 12, output_tokens: 3 },
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(event), {
      type: "turn.completed",
      response: "AGY_OK\n",
      durationSeconds: 0.806,
      numTurns: 1,
      usage: { input_tokens: 12, output_tokens: 3 },
    });

    const canceled = parseAntigravityStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-123",
          status: "CANCELED",
          response: "user canceled",
        },
      }),
    );
    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(canceled), {
      type: "turn.aborted",
      status: "CANCELLED",
      response: "user canceled",
    });
  });

  it("ignores blank, malformed, and non-assistant step lines", () => {
    NodeAssert.equal(parseAntigravityStreamLine(""), null);
    NodeAssert.equal(parseAntigravityStreamLine("not-json"), null);

    const event = parseAntigravityStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 0,
          step_type: "user_input",
          state: "DONE",
        },
      }),
    );
    NodeAssert.equal(normalizeAntigravityCliEvent(event), null);
  });

  it("maps a failed result to a terminal abort", () => {
    const event = parseAntigravityStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-123",
          status: "FAILED",
          response: "Provider failed",
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(event), {
      type: "turn.aborted",
      status: "FAILED",
      response: "Provider failed",
    });

    const errorEvent = parseAntigravityStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "",
          status: "ERROR",
          response: "",
          error: "context canceled",
        },
      }),
    );

    NodeAssert.deepStrictEqual(normalizeAntigravityCliEvent(errorEvent), {
      type: "turn.aborted",
      status: "ERROR",
      response: "context canceled",
    });
  });
});

describe("Antigravity capability probes", () => {
  it("distinguishes unavailable, unauthenticated, and available states", () => {
    NodeAssert.deepStrictEqual(
      classifyAntigravityAvailability({
        version: { exitCode: 127, stdout: "", stderr: "agy: command not found" },
        models: null,
      }),
      { status: "unavailable", reason: "agy: command not found" },
    );

    NodeAssert.deepStrictEqual(
      classifyAntigravityAvailability({
        version: { exitCode: 0, stdout: "1.1.22\n", stderr: "" },
        models: { exitCode: 1, stdout: "", stderr: "authentication required" },
      }),
      {
        status: "unauthenticated",
        version: "1.1.22",
        reason: "authentication required",
      },
    );

    NodeAssert.deepStrictEqual(
      classifyAntigravityAvailability({
        version: { exitCode: 0, stdout: "1.1.22\n", stderr: "" },
        models: { exitCode: 0, stdout: "models", stderr: "note: cached" },
      }),
      { status: "available", version: "1.1.22" },
    );
  });

  it("maps process cancellation and missing terminal results", () => {
    NodeAssert.deepStrictEqual(
      normalizeAntigravityProcessExit({
        exitCode: null,
        signal: "SIGTERM",
        terminalResultSeen: false,
      }),
      {
        type: "turn.aborted",
        status: "CANCELLED",
        response: "Agy process terminated by SIGTERM",
      },
    );

    NodeAssert.deepStrictEqual(
      normalizeAntigravityProcessExit({
        exitCode: 0,
        signal: null,
        terminalResultSeen: false,
      }),
      {
        type: "turn.aborted",
        status: "PROTOCOL_ERROR",
        response: "Agy exited without a terminal result event",
      },
    );

    NodeAssert.equal(
      normalizeAntigravityProcessExit({
        exitCode: 0,
        signal: null,
        terminalResultSeen: true,
      }),
      null,
    );
  });
});
