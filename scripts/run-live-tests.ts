import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

import { loadConfig } from "../src/config/index.js";

type LiveMode = "standard" | "delete" | "acceptance";

function determineMode(arguments_: readonly string[]): LiveMode {
  const deleteMode = arguments_.includes("--delete");
  const acceptanceMode = arguments_.includes("--acceptance");

  if (deleteMode && acceptanceMode) {
    throw new Error("Choose either --delete or --acceptance, not both");
  }

  if (deleteMode) {
    return "delete";
  }

  return acceptanceMode ? "acceptance" : "standard";
}

function requireEnvironment(name: string): void {
  if (process.env[name] !== "1") {
    throw new Error(`${name}=1 is required`);
  }
}

async function main(): Promise<void> {
  const mode = determineMode(process.argv.slice(2));
  requireEnvironment("CHATGPT_PROXY_LIVE_TESTS");

  const configPath = process.env.CHATGPT_PROXY_CONFIG;
  if (configPath === undefined || configPath === "") {
    throw new Error("CHATGPT_PROXY_CONFIG must name an absolute TOML config path");
  }
  if (!isAbsolute(configPath)) {
    throw new Error("CHATGPT_PROXY_CONFIG must be an absolute path");
  }

  const config = await loadConfig(configPath);
  if (!config.liveTests.enabled) {
    throw new Error("live_tests.enabled must be true in the selected config");
  }

  const destructiveAcceptance =
    mode === "acceptance" &&
    process.env.CHATGPT_PROXY_ACCEPTANCE_REMOTE_DELETE === "1";
  if (mode === "delete" || destructiveAcceptance) {
    requireEnvironment("CHATGPT_PROXY_LIVE_DELETE");
    if (!config.chatGpt.deleteRemoteThread) {
      throw new Error(
        "chatgpt.delete_remote_thread must be true for destructive live operations",
      );
    }
    if (!config.liveTests.allowRemoteDeletion) {
      throw new Error(
        "live_tests.allow_remote_deletion must be true for destructive live operations",
      );
    }
  }

  const commandArguments =
    mode === "acceptance"
      ? ["exec", "tsx", "scripts/live-acceptance.ts"]
      : [
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.live.config.ts",
          "--passWithNoTests",
        ];
  const result = spawnSync(
    "pnpm",
    commandArguments,
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CHATGPT_PROXY_LIVE_MODE: mode,
      },
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }

  process.exitCode = result.status ?? 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live test gate rejected execution: ${message}\n`);
  process.exitCode = 1;
}
