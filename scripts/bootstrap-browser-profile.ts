#!/usr/bin/env node

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

import { loadConfig } from "../src/config/index.js";

const DEFAULT_CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/google-chrome",
] as const;

async function findChromeExecutable(): Promise<string> {
  const configured = process.env.CHATGPT_PROXY_CHROME_PATH;
  const candidates = configured === undefined
    ? DEFAULT_CHROME_PATHS
    : [configured, ...DEFAULT_CHROME_PATHS];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported location.
    }
  }

  throw new Error(
    "Google Chrome is not installed. Run 'pnpm browser:install:chrome' in an interactive terminal first.",
  );
}

async function browserExecutable(
  channel: "chromium" | "chrome",
): Promise<string> {
  return channel === "chromium"
    ? chromium.executablePath()
    : findChromeExecutable();
}

async function main(): Promise<void> {
  const configPath = process.env.CHATGPT_PROXY_CONFIG ?? "./config.toml";
  const config = await loadConfig(configPath);
  const executable = await browserExecutable(config.browser.channel);

  process.stdout.write(
    "Opening the configured browser without Playwright control for one-time profile authentication.\n" +
      "Sign in to ChatGPT, verify the configured project opens, then close every browser window completely.\n",
  );

  const child = spawn(
    executable,
    [
      `--user-data-dir=${config.chatGpt.profileDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      config.chatGpt.projectUrl,
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`Browser exited after signal ${signal}`));
        return;
      }
      resolve(code ?? 0);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`Browser exited with code ${exitCode}`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
