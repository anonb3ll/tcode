import {
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  classifyAntigravityAvailability,
  type AntigravityProbeCommandResult,
} from "../antigravity/AntigravityCliProtocol.ts";

const ANTIGRAVITY_PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Native",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

export const ANTIGRAVITY_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash (High)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash (Medium)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash (Low)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gemini-3.1-pro-high",
    name: "Gemini 3.1 Pro (High)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-sonnet-4.6-thinking",
    name: "Claude Sonnet 4.6 (Thinking)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-4.6-thinking",
    name: "Claude Opus 4.6 (Thinking)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B (Medium)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialAntigravityProviderSnapshot(
  antigravitySettings: AntigravitySettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = antigravityModelsFromSettings(antigravitySettings.customModels);

    if (!antigravitySettings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Antigravity (agy) CLI availability...",
      },
    });
  });
}

function antigravityModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ANTIGRAVITY_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runAntigravityVersionCommand = (
  antigravitySettings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = antigravitySettings.binaryPath || "agy";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    antigravitySettings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = antigravityModelsFromSettings(antigravitySettings.customModels);

    if (!antigravitySettings.enabled) {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runAntigravityVersionCommand(
      antigravitySettings,
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      const missing = isCommandMissingCause(error);
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? `Antigravity CLI (${antigravitySettings.binaryPath || "agy"}) was not found in PATH.`
            : "Failed to probe Antigravity CLI version.",
        },
      });
    }

    const versionCollected = versionResult.success;
    if (versionCollected._tag === "None") {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Antigravity CLI probe timed out.",
        },
      });
    }

    const versionOutput =
      versionCollected.value.stdout.trim() || versionCollected.value.stderr.trim();
    const parsedVersion = parseGenericCliVersion(versionOutput);

    const versionProbeResult: AntigravityProbeCommandResult = {
      exitCode: versionCollected.value.code,
      stdout: versionCollected.value.stdout,
      stderr: versionCollected.value.stderr,
    };

    const availability = classifyAntigravityAvailability({
      version: versionProbeResult,
      models: { exitCode: 0, stdout: "models", stderr: "" },
    });

    if (availability.status === "unavailable") {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: availability.reason,
        },
      });
    }

    if (availability.status === "unauthenticated") {
      return buildServerProvider({
        presentation: ANTIGRAVITY_PRESENTATION,
        enabled: antigravitySettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "warning",
          auth: { status: "unauthenticated" },
          message: availability.reason,
        },
      });
    }

    return buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: antigravitySettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: { status: "authenticated" },
        message: `Antigravity CLI ${parsedVersion || "available"} is ready.`,
      },
    });
  },
);
