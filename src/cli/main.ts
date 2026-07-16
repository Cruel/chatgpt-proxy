#!/usr/bin/env node

import { CommanderError } from "commander";

import type { CliCommandExecutor } from "./contracts.js";
import { runCli } from "./program.js";

const unavailableExecutor: CliCommandExecutor = {
  execute(invocation) {
    return Promise.reject(
      new Error(
        `The '${invocation.command.kind}' HTTP client is implemented in Phase 3`,
      ),
    );
  },
};

try {
  await runCli(process.argv.slice(2), unavailableExecutor);
} catch (error) {
  if (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" ||
      error.code === "commander.version")
  ) {
    process.exitCode = 0;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
