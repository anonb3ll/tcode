import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildAntigravityPrintArgs,
  classifyAntigravityAvailability,
  normalizeAntigravityCliEvent,
  normalizeAntigravityProcessExit,
  parseAntigravityStreamLine,
} from "./AntigravityCliProtocol.ts";

describe("buildAntigravityPrintArgs", () => {
  it("builds a bounded read-only stream-json launch", () => {
    NodeAssert.deepStrictEqual(
      buildAntigravityPrintArgs({
        prompt: "Inspect the repository without changing files.",
        model: "gemini-3.7-flash-low",
        effort: "low",
      }),
      [
        "--print",
        "Inspect the repository without changing files.",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--sandbox",
        "--model",
        "gemini-3.7-flash-low",
        "--effort",
        "low",
      ],
    );
  });

  it("resumes an existing conversation without weakening safeguards", () => {
    NodeAssert.deepStrictEqual(
      buildAntigravityPrintArgs({
        prompt: "Continue the inspection.",
        conversationId: "conversation-123",
      }),
      [
        "--print",
        "Continue the inspection.",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--sandbox",
        "--conversation",
        "conversation-123",
      ],
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

  it("normalizes terminal results", () => {
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
        models: { exitCode: 0, stdout: "models", stderr: "" },
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
