#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  createChatGptBrowserAdapterFromConfig,
  type ChatGptBrowserAdapter,
  type RemoteConversationReference,
} from "../src/browser/index.js";
import { loadConfig, type AppConfig } from "../src/config/index.js";
import type { MutationResult } from "../src/service/proxy-service.js";
import { createProxyRuntime, type ProxyRuntime } from "../src/runtime.js";

const AUTOMATIC_ACCEPTANCE =
  process.env.CHATGPT_PROXY_ACCEPTANCE_YES === "1";

function line(message = ""): void {
  process.stdout.write(`${message}\n`);
}

async function confirmStep(message: string): Promise<void> {
  if (AUTOMATIC_ACCEPTANCE) {
    line(`${message} [automatic acceptance enabled]`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Manual acceptance requires an interactive terminal or CHATGPT_PROXY_ACCEPTANCE_YES=1",
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${message} [Enter/q] `);
    if (answer.trim().toLowerCase() === "q") {
      throw new Error("Manual acceptance cancelled by operator");
    }
  } finally {
    readline.close();
  }
}

async function confirmRemoteDeletion(): Promise<boolean> {
  if (process.env.CHATGPT_PROXY_ACCEPTANCE_REMOTE_DELETE === "1") {
    return true;
  }
  if (AUTOMATIC_ACCEPTANCE || !process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      "Run the optional separately gated remote-deletion scenario? [y/N] ",
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    readline.close();
  }
}

function requireSucceeded(label: string, result: MutationResult): MutationResult {
  if (result.run.state !== "succeeded") {
    throw new Error(
      `${label} ended in '${result.run.state}': ${result.run.errorMessage ?? "unknown error"}`,
    );
  }
  return result;
}

function remoteReference(
  runtime: ProxyRuntime,
  localName: string,
): RemoteConversationReference {
  const thread = runtime.persistence.threads.getByName(localName);
  if (
    thread?.remoteConversationId === null ||
    thread?.remoteConversationId === undefined ||
    thread.remoteUrl === null
  ) {
    throw new Error(`Thread '${localName}' has no persisted remote mapping`);
  }
  return {
    conversationId: thread.remoteConversationId,
    url: thread.remoteUrl,
    title: thread.remoteTitle,
  };
}

function acceptanceContext(marker: string) {
  return {
    runId: `acceptance-inspection-${marker}`,
    threadId: `acceptance-thread-${marker}`,
    signal: new AbortController().signal,
  };
}

async function waitForBrowser(adapter: ChatGptBrowserAdapter): Promise<void> {
  const status = await adapter.getStatus();
  if (status.status === "ready") {
    return;
  }
  if (
    status.status === "auth_required" ||
    status.status === "verification_required"
  ) {
    line(
      `Browser interaction required: ${status.detail ?? status.status}. Complete it in the headed browser window.`,
    );
    await adapter.waitForReady({ timeoutMs: 10 * 60 * 1_000 });
    return;
  }
  throw new Error(`Browser is not ready: ${status.detail ?? status.status}`);
}

async function main(): Promise<void> {
  const configPath = process.env.CHATGPT_PROXY_CONFIG;
  if (configPath === undefined || configPath.length === 0) {
    throw new Error("CHATGPT_PROXY_CONFIG is required for live acceptance");
  }
  const config = await loadConfig(configPath);
  const marker = `${config.liveTests.threadPrefix}-acceptance-${Date.now().toString(36)}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "chatgpt-proxy-acceptance-"));
  const acceptanceArtifactDirectory = join(
    config.diagnostics.artifactDirectory,
    "acceptance",
    marker,
  );
  await mkdir(acceptanceArtifactDirectory, { recursive: true, mode: 0o700 });
  const acceptanceConfig: AppConfig = {
    ...config,
    chatGpt: {
      ...config.chatGpt,
      projectUrl: config.liveTests.projectUrl,
    },
    database: { path: join(temporaryRoot, "acceptance.sqlite3") },
    diagnostics: {
      ...config.diagnostics,
      artifactDirectory: acceptanceArtifactDirectory,
    },
  };

  const adapter = createChatGptBrowserAdapterFromConfig(acceptanceConfig);
  await adapter.start();
  let runtime: ProxyRuntime | null = null;
  const retainedRemoteConversations: RemoteConversationReference[] = [];
  try {
    runtime = createProxyRuntime({ config: acceptanceConfig, adapter });
    line("ChatGPT proxy manual acceptance");
    line(`Project: ${acceptanceConfig.liveTests.projectUrl}`);
    line(`Marker: ${marker}`);
    await waitForBrowser(adapter);

    const doctor = await runtime.service.getDoctorReport();
    line(`Operational doctor status: ${doctor.status}`);
    for (const diagnostic of doctor.checks.filter(
      (candidate) => candidate.status !== "ok",
    )) {
      line(`- ${diagnostic.status.toUpperCase()}: ${diagnostic.summary}`);
      if (diagnostic.remediation !== null) {
        line(`  Action: ${diagnostic.remediation}`);
      }
    }
    if (doctor.status === "error") {
      throw new Error("Operational doctor found blocking errors");
    }

    await confirmStep(
      "The browser and configured project are ready. Continue with remote conversation creation?",
    );

    const primaryName = `${marker}-primary`;
    requireSucceeded(
      "primary create",
      await runtime.service.createThread({
        name: primaryName,
        message:
          `Manual acceptance marker ${marker}. Reply with one short sentence confirming receipt.`,
        wait: true,
        idempotencyKey: `${marker}-create-primary`,
      }),
    );
    const primaryRemote = remoteReference(runtime, primaryName);
    retainedRemoteConversations.push(primaryRemote);
    line(`Create passed: ${primaryRemote.url}`);

    requireSucceeded(
      "primary follow-up",
      await runtime.service.sendMessage({
        name: primaryName,
        message: "Confirm this follow-up remained in the same conversation.",
        wait: true,
        idempotencyKey: `${marker}-chat-primary`,
      }),
    );
    line("Chat follow-up passed.");

    const parallelNames = [`${marker}-parallel-a`, `${marker}-parallel-b`] as const;
    const parallelCreates = await Promise.all(
      parallelNames.map((name, index) =>
        runtime!.service.createThread({
          name,
          message: `Parallel acceptance conversation ${index + 1} for ${marker}. Reply briefly.`,
          wait: true,
          idempotencyKey: `${marker}-create-parallel-${index + 1}`,
        }),
      ),
    );
    parallelCreates.forEach((result, index) =>
      requireSucceeded(`parallel create ${index + 1}`, result),
    );
    const parallelRemotes = parallelNames.map((name) =>
      remoteReference(runtime!, name),
    );
    retainedRemoteConversations.push(...parallelRemotes);
    await Promise.all(
      parallelNames.map((name, index) =>
        runtime!.service.sendMessage({
          name,
          message: `Parallel follow-up ${index + 1}; reply briefly.`,
          wait: true,
          idempotencyKey: `${marker}-chat-parallel-${index + 1}`,
        }),
      ),
    ).then((results) =>
      results.forEach((result, index) =>
        requireSucceeded(`parallel chat ${index + 1}`, result),
      ),
    );
    line("Parallel create and chat passed.");

    requireSucceeded(
      "local deletion",
      await runtime.service.deleteThread({
        name: primaryName,
        deleteRemote: false,
        wait: true,
        idempotencyKey: `${marker}-delete-local`,
      }),
    );
    const remoteAfterLocalDelete = await runtime.adapter.inspectConversation(
      primaryRemote,
      acceptanceContext(randomUUID()),
    );
    if (!remoteAfterLocalDelete.ok || remoteAfterLocalDelete.value.state !== "ready") {
      throw new Error(
        "Local-only deletion did not leave the remote acceptance conversation available",
      );
    }
    line("Local-only deletion passed; the remote conversation remains available.");

    if (await confirmRemoteDeletion()) {
      if (
        process.env.CHATGPT_PROXY_LIVE_DELETE !== "1" ||
        !acceptanceConfig.liveTests.allowRemoteDeletion ||
        !acceptanceConfig.chatGpt.deleteRemoteThread
      ) {
        throw new Error(
          "Optional remote deletion requires CHATGPT_PROXY_LIVE_DELETE=1, live_tests.allow_remote_deletion=true, and chatgpt.delete_remote_thread=true",
        );
      }
      const disposableName = `${marker}-remote-delete`;
      requireSucceeded(
        "remote-delete fixture create",
        await runtime.service.createThread({
          name: disposableName,
          message: `Disposable remote-deletion acceptance marker ${marker}. Reply briefly.`,
          wait: true,
          idempotencyKey: `${marker}-create-remote-delete`,
        }),
      );
      requireSucceeded(
        "remote deletion",
        await runtime.service.deleteThread({
          name: disposableName,
          deleteRemote: true,
          wait: true,
          idempotencyKey: `${marker}-delete-remote`,
        }),
      );
      line("Optional remote deletion passed.");
    } else {
      line("Optional remote deletion skipped.");
    }

    line();
    line("Manual acceptance completed.");
    line(`Diagnostic artifact directory: ${acceptanceArtifactDirectory}`);
    line("Remote conversations intentionally retained for visual review:");
    for (const conversation of retainedRemoteConversations) {
      line(`- ${conversation.url}`);
    }
    line(
      "Inspect the project and artifact directory, then remove retained acceptance conversations manually when no longer needed.",
    );
  } finally {
    await runtime?.close().catch(() => undefined);
    if (runtime === null) {
      await adapter.close().catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Manual acceptance failed: ${message}\n`);
  process.exitCode = 1;
}
