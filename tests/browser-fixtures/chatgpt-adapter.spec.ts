import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  BrowserManager,
  ChatGptBrowserAdapter,
  type BrowserOperationContext,
  type RemoteConversationReference,
} from "../../src/browser/index.js";
import {
  startBrowserFixtureServer,
  type BrowserFixtureServer,
} from "./fixture-server.js";

interface TestResources {
  readonly directory: string;
  readonly server: BrowserFixtureServer;
  readonly adapters: ChatGptBrowserAdapter[];
}

async function createResources(): Promise<TestResources> {
  return {
    directory: await mkdtemp(join(tmpdir(), "chatgpt-proxy-adapter-")),
    server: await startBrowserFixtureServer(),
    adapters: [],
  };
}

async function disposeResources(resources: TestResources): Promise<void> {
  await Promise.all(resources.adapters.map((adapter) => adapter.close()));
  await resources.server.close();
  await rm(resources.directory, { recursive: true, force: true });
}

function createAdapter(
  resources: TestResources,
  startupPath: string,
  options: {
    readonly submissionTimeoutMs?: number;
    readonly responseTimeoutMs?: number;
    readonly stableContentMs?: number;
  } = {},
): ChatGptBrowserAdapter {
  const manager = new BrowserManager({
    profileDirectory: join(
      resources.directory,
      `profile-${resources.adapters.length}`,
    ),
    startupUrl: `${resources.server.baseUrl}${startupPath}`,
    headless: true,
    maxConcurrentPages: 2,
    pageIdleTimeoutMs: 100,
    navigationTimeoutMs: 2_000,
    statusPollIntervalMs: 25,
    recoveryDelaysMs: [0, 25, 50],
  });
  const adapter = new ChatGptBrowserAdapter({
    manager,
    navigationTimeoutMs: 2_000,
    submissionTimeoutMs: options.submissionTimeoutMs ?? 1_000,
    responseTimeoutMs: options.responseTimeoutMs ?? 2_000,
    pollIntervalMs: 20,
    stableContentMs: options.stableContentMs ?? 80,
  });
  resources.adapters.push(adapter);
  return adapter;
}

function operationContext(
  onConversationIdentified?: (
    conversation: RemoteConversationReference,
  ) => void,
): BrowserOperationContext {
  const controller = new AbortController();
  return {
    runId: "fixture-run",
    threadId: "fixture-thread",
    signal: controller.signal,
    ...(onConversationIdentified === undefined
      ? {}
      : { onConversationIdentified }),
  };
}

test("creates a project conversation and returns only final assistant content", async () => {
  const resources = await createResources();
  try {
    const projectUrl = `${resources.server.baseUrl}/project/example?scenario=tool-progress`;
    const adapter = createAdapter(resources, "/project/example?scenario=tool-progress");
    await expect(adapter.start()).resolves.toMatchObject({ status: "ready" });

    const identified: RemoteConversationReference[] = [];
    const result = await adapter.createConversation(
      {
        projectUrl,
        message: "Review the fixture architecture.",
      },
      operationContext((conversation) => identified.push(conversation)),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.text).toBe(
      "Final response to: Review the fixture architecture.\n\nSecond paragraph.",
    );
    expect(result.value.text).not.toContain("Intermediate text");
    expect(result.value.text).not.toContain("Searching fixture data");
    expect(result.value.conversation.conversationId).toBe(
      "fixture-conversation-1",
    );
    expect(identified.map((conversation) => conversation.conversationId)).toContain(
      "fixture-conversation-1",
    );
  } finally {
    await disposeResources(resources);
  }
});

test("activates the project new-chat action when the composer is initially absent", async () => {
  const resources = await createResources();
  try {
    const path = "/project/example?scenario=requires-new-chat";
    const adapter = createAdapter(resources, path);
    await expect(adapter.start()).resolves.toMatchObject({ status: "ready" });

    const result = await adapter.createConversation(
      {
        projectUrl: `${resources.server.baseUrl}${path}`,
        message: "Start through the project action.",
      },
      operationContext(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        conversation: { conversationId: "fixture-conversation-1" },
      },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("waits for an asynchronously hydrated project composer", async () => {
  const resources = await createResources();
  try {
    const path = "/project/example?scenario=delayed-composer";
    const adapter = createAdapter(resources, path);
    await expect(adapter.start()).resolves.toMatchObject({ status: "ready" });

    const result = await adapter.createConversation(
      {
        projectUrl: `${resources.server.baseUrl}${path}`,
        message: "Wait for the hydrated composer.",
      },
      operationContext(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        conversation: { conversationId: "fixture-conversation-1" },
      },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("continues an existing conversation without returning an older turn", async () => {
  const resources = await createResources();
  try {
    const url = `${resources.server.baseUrl}/c/existing-conversation?scenario=stable-no-copy`;
    const adapter = createAdapter(
      resources,
      "/project/example",
      { stableContentMs: 60 },
    );
    await adapter.start();

    const result = await adapter.sendMessage(
      {
        conversation: {
          conversationId: "existing-conversation",
          url,
          title: "Existing fixture",
        },
        message: "Continue with failure handling.",
      },
      operationContext(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe(
        "Final response to: Continue with failure handling.\n\nSecond paragraph.",
      );
      expect(result.value.text).not.toContain("Existing answer");
    }
  } finally {
    await disposeResources(resources);
  }
});

test("classifies tool failures, rate limits, and confirmation prompts", async () => {
  const resources = await createResources();
  try {
    for (const expectation of [
      { scenario: "tool-failed", code: "tool_failed" },
      { scenario: "rate-limited", code: "rate_limited" },
      { scenario: "confirmation", code: "needs_confirmation" },
    ] as const) {
      const projectPath = `/project/example?scenario=${expectation.scenario}`;
      const adapter = createAdapter(resources, projectPath);
      await adapter.start();
      const result = await adapter.createConversation(
        {
          projectUrl: `${resources.server.baseUrl}${projectPath}`,
          message: `Trigger ${expectation.scenario}`,
        },
        operationContext(),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: expectation.code },
      });
    }
  } finally {
    await disposeResources(resources);
  }
});

test("treats an unconfirmed submission as ambiguous and does not retry", async () => {
  const resources = await createResources();
  try {
    const path = "/project/example?scenario=no-confirmation";
    const adapter = createAdapter(resources, path, {
      submissionTimeoutMs: 150,
      responseTimeoutMs: 300,
    });
    await adapter.start();

    const result = await adapter.createConversation(
      {
        projectUrl: `${resources.server.baseUrl}${path}`,
        message: "Do not confirm this submission.",
      },
      operationContext(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "submission_ambiguous", retryable: false },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("inspects ready, generating, and missing conversations", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const ready = await adapter.inspectConversation(
      {
        conversationId: "ready-conversation",
        url: `${resources.server.baseUrl}/c/ready-conversation`,
        title: null,
      },
      operationContext(),
    );
    expect(ready).toMatchObject({
      ok: true,
      value: { state: "ready", partialAssistantText: "Existing answer" },
    });

    const missing = await adapter.inspectConversation(
      {
        conversationId: "missing-conversation",
        url: `${resources.server.baseUrl}/c/missing-conversation`,
        title: null,
      },
      operationContext(),
    );
    expect(missing).toMatchObject({
      ok: true,
      value: { state: "missing", conversation: null },
    });
  } finally {
    await disposeResources(resources);
  }
});
