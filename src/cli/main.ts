#!/usr/bin/env node

import { CommanderError } from "commander";

import { CliHttpError, HttpCliExecutor } from "./http-client.js";
import { runCli } from "./program.js";

try {
  await runCli(process.argv.slice(2), new HttpCliExecutor());
} catch (error) {
  if (
    error instanceof CommanderError &&
    (error.code === "commander.helpDisplayed" ||
      error.code === "commander.version")
  ) {
    process.exitCode = 0;
  } else {
    const message =
      error instanceof CliHttpError
        ? error.formatForStderr()
        : error instanceof Error
          ? error.message
          : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
