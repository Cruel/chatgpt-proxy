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
    readonly traceEnabled?: boolean;
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
    traceEnabled: options.traceEnabled ?? false,
  });
  const adapter = new ChatGptBrowserAdapter({
    manager,
    navigationTimeoutMs: 2_000,
    submissionTimeoutMs: options.submissionTimeoutMs ?? 1_000,
    responseTimeoutMs: options.responseTimeoutMs ?? 2_000,
    pollIntervalMs: 20,
    stableContentMs: options.stableContentMs ?? 80,
    captureScreenshotOnError: true,
    captureHtmlOnError: true,
    captureTraceOnError: options.traceEnabled ?? false,
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

test("selects the requested thinking level before submission", async () => {
  const resources = await createResources();
  try {
    const path = "/project/example?scenario=thinking-selection";
    const adapter = createAdapter(resources, path);
    await adapter.start();

    const result = await adapter.createConversation(
      {
        projectUrl: `${resources.server.baseUrl}${path}`,
        message: "Use the requested thinking level.",
        thinking: "high",
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        text: "Thinking high. Final response to: Use the requested thinking level.\n\nSecond paragraph.",
      },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("waits for an asynchronously rendered thinking menu", async () => {
  const resources = await createResources();
  try {
    const projectUrl = `${resources.server.baseUrl}/project/example?scenario=delayed-thinking-menu`;
    const adapter = createAdapter(
      resources,
      "/project/example?scenario=delayed-thinking-menu",
    );
    await adapter.start();

    const result = await adapter.createConversation(
      {
        projectUrl,
        message: "Wait for the thinking menu.",
        thinking: "high",
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        text: "Thinking high. Final response to: Wait for the thinking menu.\n\nSecond paragraph.",
      },
    });
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
      { scenario: "tool-aborted", code: "tool_failed" },
      { scenario: "generic-error", code: "send_failed" },
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

test("recovers an ambiguous submission by inspection without resubmitting", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example", {
      submissionTimeoutMs: 80,
      responseTimeoutMs: 1_000,
    });
    await adapter.start();

    const message = "Recover this ambiguous fixture submission.";
    const result = await adapter.sendMessage(
      {
        conversation: {
          conversationId: "ambiguous-recovery",
          url: `${resources.server.baseUrl}/c/ambiguous-recovery?scenario=late-ambiguous-submission`,
          title: null,
        },
        message,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        text: `Recovered response to: ${message}`,
        conversation: { conversationId: "ambiguous-recovery" },
      },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("accepts a replaced assistant turn when the turn count does not change", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example", {
      submissionTimeoutMs: 300,
      responseTimeoutMs: 1_000,
    });
    await adapter.start();

    const message = "Return a same-count fixture response.";
    const result = await adapter.sendMessage(
      {
        conversation: {
          conversationId: "same-count-response",
          url: `${resources.server.baseUrl}/c/same-count-response?scenario=same-count-response`,
          title: null,
        },
        message,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        text: `Final response to: ${message}`,
        conversation: { conversationId: "same-count-response" },
      },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("recovers a completed response after the original wait times out", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example", {
      submissionTimeoutMs: 500,
      responseTimeoutMs: 180,
    });
    await adapter.start();

    const message = "Recover this interrupted response fixture.";
    const result = await adapter.sendMessage(
      {
        conversation: {
          conversationId: "timeout-recovery",
          url: `${resources.server.baseUrl}/c/timeout-recovery?scenario=recovery-after-timeout`,
          title: null,
        },
        message,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        text: `Recovered response to: ${message}`,
        conversation: { conversationId: "timeout-recovery" },
      },
    });
  } finally {
    await disposeResources(resources);
  }
});

test("captures screenshot, HTML, DOM metadata, and trace for an unknown UI", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example", {
      traceEnabled: true,
    });
    await adapter.start();
    const context = operationContext();
    const result = await adapter.createConversation(
      {
        projectUrl: `${resources.server.baseUrl}/project/example?scenario=changed-selectors`,
        message: "This must not be submitted.",
      },
      context,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ui_changed" },
    });

    const diagnostics = await adapter.captureDiagnostics(
      {
        runId: context.runId,
        phase: "project_navigation",
        includeScreenshot: true,
        includeHtml: true,
        includeTrace: true,
      },
      context,
    );
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok) {
      expect(diagnostics.value.map((artifact) => artifact.type).sort()).toEqual([
        "dom_fragment",
        "html",
        "screenshot",
        "trace",
      ]);
      const metadata = diagnostics.value.find(
        (artifact) => artifact.type === "dom_fragment",
      );
      expect(metadata).toBeDefined();
      const decoded = new TextDecoder().decode(metadata?.data);
      expect(decoded).toContain('"failure"');
      expect(decoded).toContain('"matched_selectors"');
      expect(decoded).toContain("ui_changed");
    }
  } finally {
    await disposeResources(resources);
  }
});

test("deletes a conversation only after validating the confirmation dialog", async () => {
  const resources = await createResources();
  try {
    const conversationId = "delete-success";
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.deleteConversation(
      {
        conversationId,
        url: `${resources.server.baseUrl}/c/${conversationId}?scenario=delete-success`,
        title: "Fixture Conversation",
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "deleted" },
    });
    expect(resources.server.isConversationDeleted(conversationId)).toBe(true);
    expect(resources.server.deleteRequestCount(conversationId)).toBe(1);
  } finally {
    await disposeResources(resources);
  }
});

test("recovers a confirmed deletion by verifying absence without clicking twice", async () => {
  const resources = await createResources();
  try {
    const conversationId = "delete-verify-by-reload";
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.deleteConversation(
      {
        conversationId,
        url: `${resources.server.baseUrl}/c/${conversationId}?scenario=delete-verify-by-reload`,
        title: null,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "deleted" },
    });
    expect(resources.server.deleteRequestCount(conversationId)).toBe(1);
  } finally {
    await disposeResources(resources);
  }
});

test("treats a missing remote conversation as idempotently absent", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.deleteConversation(
      {
        conversationId: "missing-conversation",
        url: `${resources.server.baseUrl}/c/missing-conversation`,
        title: null,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "already_absent" },
    });
    expect(resources.server.deleteRequestCount("missing-conversation")).toBe(0);
  } finally {
    await disposeResources(resources);
  }
});

test("refuses an unvalidated deletion dialog without clicking confirm", async () => {
  const resources = await createResources();
  try {
    const conversationId = "delete-malformed-dialog";
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.deleteConversation(
      {
        conversationId,
        url: `${resources.server.baseUrl}/c/${conversationId}?scenario=delete-malformed-dialog`,
        title: null,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "remote_delete_failed", retryable: false },
    });
    expect(resources.server.deleteRequestCount(conversationId)).toBe(0);
    expect(resources.server.isConversationDeleted(conversationId)).toBe(false);
  } finally {
    await disposeResources(resources);
  }
});

test("preserves an ambiguous deletion instead of blindly retrying", async () => {
  const resources = await createResources();
  try {
    const conversationId = "delete-ambiguous";
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.deleteConversation(
      {
        conversationId,
        url: `${resources.server.baseUrl}/c/${conversationId}?scenario=delete-ambiguous`,
        title: null,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { outcome: "ambiguous" },
    });
    expect(resources.server.deleteRequestCount(conversationId)).toBe(0);
    expect(resources.server.isConversationDeleted(conversationId)).toBe(false);
  } finally {
    await disposeResources(resources);
  }
});

test("reports a changed UI when the conversation action menu is absent", async () => {
  const resources = await createResources();
  try {
    const conversationId = "delete-missing-action-menu";
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.deleteConversation(
      {
        conversationId,
        url: `${resources.server.baseUrl}/c/${conversationId}?scenario=delete-missing-action-menu`,
        title: null,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ui_changed" },
    });
    expect(resources.server.deleteRequestCount(conversationId)).toBe(0);
  } finally {
    await disposeResources(resources);
  }
});

test("treats a deleted conversation redirecting to a project composer as missing", async () => {
  const resources = await createResources();
  try {
    const adapter = createAdapter(resources, "/project/example");
    await adapter.start();

    const result = await adapter.inspectConversation(
      {
        conversationId: "deleted-redirect-shell",
        url: `${resources.server.baseUrl}/c/deleted-redirect-shell?scenario=deleted-redirect-shell`,
        title: null,
      },
      operationContext(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: { state: "missing", conversation: null },
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
