import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createChatGptBrowserAdapterFromConfig,
  type ChatGptBrowserAdapter,
  type RemoteConversationReference,
} from "../../src/browser/index.js";
import { loadConfig, type AppConfig } from "../../src/config/index.js";

const mode = process.env.CHATGPT_PROXY_LIVE_MODE ?? "standard";
const liveDescribe = mode === "standard" ? describe : describe.skip;

function operationContext(
  runId: string,
  onConversationIdentified?: (
    conversation: RemoteConversationReference,
  ) => void,
) {
  const controller = new AbortController();
  return {
    runId,
    threadId: `live-thread-${runId}`,
    signal: controller.signal,
    ...(onConversationIdentified === undefined
      ? {}
      : { onConversationIdentified }),
  };
}

liveDescribe("live ChatGPT create and continue", () => {
  let config: AppConfig;
  let adapter: ChatGptBrowserAdapter;
  let createdConversation: RemoteConversationReference;

  beforeAll(async () => {
    const configPath = process.env.CHATGPT_PROXY_CONFIG;
    if (configPath === undefined || configPath.length === 0) {
      throw new Error("CHATGPT_PROXY_CONFIG is required for live tests");
    }
    config = await loadConfig(configPath);
    const liveConfig: AppConfig = {
      ...config,
      chatGpt: {
        ...config.chatGpt,
        projectUrl: config.liveTests.projectUrl,
      },
    };
    adapter = createChatGptBrowserAdapterFromConfig(liveConfig);

    const status = await adapter.start();
    if (
      status.status === "auth_required" ||
      status.status === "verification_required"
    ) {
      process.stderr.write(
        `\nBrowser interaction required: ${status.detail ?? status.status}. ` +
          "Complete login or verification in the opened Chromium window.\n",
      );
      await adapter.waitForReady({ timeoutMs: 10 * 60 * 1_000 });
    }
  }, 11 * 60 * 1_000);

  afterAll(async () => {
    await adapter?.close();
  });

  test(
    "creates a conversation in the configured project",
    async () => {
      const marker = `${config.liveTests.threadPrefix}-${Date.now().toString(36)}`;
      const identified: RemoteConversationReference[] = [];
      const result = await adapter.createConversation(
        {
          projectUrl: config.liveTests.projectUrl,
          message:
            `This is an automated smoke test named ${marker}. ` +
            "Reply with one short sentence confirming that you received it.",
        },
        operationContext("create", (conversation) => identified.push(conversation)),
      );

      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      expect(result.ok).toBe(true);
      expect(result.value.text.trim().length).toBeGreaterThan(0);
      expect(result.value.conversation.conversationId.length).toBeGreaterThan(0);
      expect(identified.length).toBeGreaterThan(0);
      createdConversation = result.value.conversation;
    },
    31 * 60 * 1_000,
  );

  test(
    "sends a follow-up to the same conversation",
    async () => {
      const result = await adapter.sendMessage(
        {
          conversation: createdConversation,
          message:
            "Reply with one short sentence confirming this follow-up remained in the same conversation.",
        },
        operationContext("follow-up"),
      );

      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      expect(result.ok).toBe(true);
      expect(result.value.text.trim().length).toBeGreaterThan(0);
      expect(result.value.conversation.conversationId).toBe(
        createdConversation.conversationId,
      );
    },
    31 * 60 * 1_000,
  );
});
