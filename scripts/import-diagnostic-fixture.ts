#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  normalizeFixtureName,
  sanitizeDiagnosticHtml,
} from "../src/diagnostics/fixture-corpus.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

async function main(): Promise<void> {
  const artifact = argument("--artifact");
  const requestedName = argument("--name");
  if (artifact === null || requestedName === null) {
    throw new Error(
      "Usage: pnpm fixture:import -- --artifact <captured.html> --name <fixture-name>",
    );
  }

  const name = normalizeFixtureName(requestedName);
  const inputPath = resolve(artifact);
  const outputPath = resolve("tests", "fixtures", "chatgpt", `${name}.html`);
  const sanitized = sanitizeDiagnosticHtml(await readFile(inputPath, "utf8"));
  await writeFile(outputPath, sanitized, {
    encoding: "utf8",
    flag: process.argv.includes("--force") ? "w" : "wx",
    mode: 0o600,
  });
  process.stdout.write(`${outputPath}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
