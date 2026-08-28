export type AntigravityEffort = "low" | "medium" | "high";

export interface AntigravityPrintOptions {
  readonly prompt: string;
  readonly conversationId?: string;
  readonly model?: string;
  readonly effort?: AntigravityEffort;
}

export interface AntigravityProbeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AntigravityAvailabilityProbe {
  readonly version: AntigravityProbeCommandResult;
  readonly models: AntigravityProbeCommandResult | null;
}

export type AntigravityAvailability =
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "unauthenticated";
      readonly version: string;
      readonly reason: string;
    }
  | { readonly status: "available"; readonly version: string };

export interface AntigravityProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly terminalResultSeen: boolean;
}

interface AntigravityInitEvent {
  readonly event: "init";
  readonly conversation_id: string;
  readonly init: Readonly<Record<string, unknown>>;
}

interface AntigravityStepUpdateEvent {
  readonly event: "step_update";
  readonly step_update: Readonly<Record<string, unknown>>;
}

interface AntigravityResultPayload {
  readonly conversation_id: string;
  readonly status: string;
  readonly response?: string;
  readonly duration_seconds?: number;
  readonly num_turns?: number;
  readonly usage?: Readonly<Record<string, unknown>>;
}

interface AntigravityResultEvent {
  readonly event: "result";
  readonly result: AntigravityResultPayload;
}

export type AntigravityCliEvent =
  | AntigravityInitEvent
  | AntigravityStepUpdateEvent
  | AntigravityResultEvent;

export type AntigravityProviderSignal =
  | {
      readonly type: "session.started";
      readonly conversationId: string;
      readonly model?: string;
      readonly cwd?: string;
      readonly permissionMode?: string;
    }
  | {
      readonly type: "content.delta";
      readonly stepIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "turn.completed";
      readonly response: string;
      readonly durationSeconds?: number;
      readonly numTurns?: number;
      readonly usage?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "turn.aborted";
      readonly status: string;
      readonly response?: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const buildAntigravityPrintArgs = (
  options: AntigravityPrintOptions,
): ReadonlyArray<string> => {
  const args = [
    "--print",
    options.prompt,
    "--output-format",
    "stream-json",
    "--mode",
    "plan",
    "--sandbox",
  ];

  if (options.conversationId !== undefined) {
    args.push("--conversation", options.conversationId);
  }
  if (options.model !== undefined) {
    args.push("--model", options.model);
  }
  if (options.effort !== undefined) {
    args.push("--effort", options.effort);
  }

  return args;
};

const commandDiagnostic = (result: AntigravityProbeCommandResult, fallback: string): string =>
  result.stderr.trim() || result.stdout.trim() || fallback;

export const classifyAntigravityAvailability = (
  probe: AntigravityAvailabilityProbe,
): AntigravityAvailability => {
  if (probe.version.exitCode !== 0) {
    return {
      status: "unavailable",
      reason: commandDiagnostic(probe.version, "agy executable is unavailable"),
    };
  }

  const version = probe.version.stdout.trim() || "unknown";
  if (probe.models === null || probe.models.exitCode !== 0) {
    return {
      status: "unauthenticated",
      version,
      reason:
        probe.models === null
          ? "agy models authentication probe was not completed"
          : commandDiagnostic(probe.models, "agy model access is unavailable"),
    };
  }

  return { status: "available", version };
};

export const parseAntigravityStreamLine = (line: string): AntigravityCliEvent | null => {
  if (line.trim().length === 0) return null;

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.event !== "string") return null;

  if (value.event === "init" && typeof value.conversation_id === "string" && isRecord(value.init)) {
    return value as unknown as AntigravityInitEvent;
  }
  if (value.event === "step_update" && isRecord(value.step_update)) {
    return value as unknown as AntigravityStepUpdateEvent;
  }
  if (
    value.event === "result" &&
    isRecord(value.result) &&
    typeof value.result.conversation_id === "string" &&
    typeof value.result.status === "string"
  ) {
    return value as unknown as AntigravityResultEvent;
  }

  return null;
};

export const normalizeAntigravityCliEvent = (
  event: AntigravityCliEvent | null,
): AntigravityProviderSignal | null => {
  if (event === null) return null;

  if (event.event === "init") {
    const model = event.init.model;
    const cwd = event.init.cwd;
    const permissionMode = event.init.permission_mode;
    return {
      type: "session.started",
      conversationId: event.conversation_id,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
      ...(typeof permissionMode === "string" ? { permissionMode } : {}),
    };
  }

  if (event.event === "step_update") {
    const stepType = event.step_update.step_type;
    const stepIndex = event.step_update.step_index;
    const text = event.step_update.text_delta;
    if (
      stepType !== "agent_response" ||
      typeof stepIndex !== "number" ||
      typeof text !== "string" ||
      text.length === 0
    ) {
      return null;
    }
    return { type: "content.delta", stepIndex, text };
  }

  if (event.result.status === "SUCCESS") {
    return {
      type: "turn.completed",
      response: event.result.response ?? "",
      ...(event.result.duration_seconds !== undefined
        ? { durationSeconds: event.result.duration_seconds }
        : {}),
      ...(event.result.num_turns !== undefined ? { numTurns: event.result.num_turns } : {}),
      ...(event.result.usage !== undefined ? { usage: event.result.usage } : {}),
    };
  }

  return {
    type: "turn.aborted",
    status: event.result.status,
    ...(event.result.response !== undefined ? { response: event.result.response } : {}),
  };
};

export const normalizeAntigravityProcessExit = (
  processExit: AntigravityProcessExit,
): AntigravityProviderSignal | null => {
  if (processExit.terminalResultSeen) return null;

  if (processExit.signal !== null) {
    return {
      type: "turn.aborted",
      status: "CANCELLED",
      response: `Agy process terminated by ${processExit.signal}`,
    };
  }

  if (processExit.exitCode === 0) {
    return {
      type: "turn.aborted",
      status: "PROTOCOL_ERROR",
      response: "Agy exited without a terminal result event",
    };
  }

  return {
    type: "turn.aborted",
    status:
      processExit.exitCode === null ? "PROTOCOL_ERROR" : `PROCESS_EXIT_${processExit.exitCode}`,
    response:
      processExit.exitCode === null
        ? "Agy process closed without an exit status or terminal result"
        : `Agy process exited with code ${processExit.exitCode}`,
  };
};
