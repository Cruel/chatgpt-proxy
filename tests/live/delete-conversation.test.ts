import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createChatGptBrowserAdapterFromConfig,
  type ChatGptBrowserAdapter,
} from "../../src/browser/index.js";
import { loadConfig, type AppConfig } from "../../src/config/index.js";

const mode = process.env.CHATGPT_PROXY_LIVE_MODE ?? "standard";
const liveDescribe = mode === "delete" ? describe : describe.skip;

function operationContext(runId: string) {
  const controller = new AbortController();
  return {
    runId,
    threadId: `live-delete-thread-${runId}`,
    signal: controller.signal,
  };
}

liveDescribe("live ChatGPT remote deletion", () => {
  let config: AppConfig;
  let adapter: ChatGptBrowserAdapter;

  beforeAll(async () => {
    const configPath = process.env.CHATGPT_PROXY_CONFIG;
    if (configPath === undefined || configPath.length === 0) {
      throw new Error("CHATGPT_PROXY_CONFIG is required for live tests");
    }
    config = await loadConfig(configPath);
    if (!config.chatGpt.deleteRemoteThread) {
      throw new Error("Remote deletion is disabled in the selected config");
    }
    if (!config.liveTests.allowRemoteDeletion) {
      throw new Error("Live remote deletion is disabled in the selected config");
    }

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
    "creates and deletes only its own test conversation",
    async () => {
      const marker =
        `${config.liveTests.threadPrefix}-delete-` + Date.now().toString(36);
      const created = await adapter.createConversation(
        {
          projectUrl: config.liveTests.projectUrl,
          message:
            `This is the destructive live-test conversation ${marker}. ` +
            "Reply with one short sentence. This conversation will then be deleted by the same test.",
        },
        operationContext("create"),
      );
      if (!created.ok) {
        throw new Error(`${created.error.code}: ${created.error.message}`);
      }
      expect(created.value.conversation.conversationId.length).toBeGreaterThan(0);

      const deleted = await adapter.deleteConversation(
        created.value.conversation,
        operationContext("delete"),
      );
      if (!deleted.ok) {
        throw new Error(`${deleted.error.code}: ${deleted.error.message}`);
      }
      if (deleted.value.outcome !== "deleted") {
        const inspection = await adapter.inspectConversation(
          created.value.conversation,
          operationContext("ambiguous-verify"),
        );
        throw new Error(
          `Remote deletion outcome was ${deleted.value.outcome}. ` +
            `Evidence: ${deleted.value.evidence.join(" | ")}. ` +
            `Inspection: ${JSON.stringify(inspection)}`,
        );
      }

      const inspection = await adapter.inspectConversation(
        created.value.conversation,
        operationContext("verify"),
      );
      if (!inspection.ok) {
        throw new Error(`${inspection.error.code}: ${inspection.error.message}`);
      }
      expect(inspection.value.state).toBe("missing");
    },
    32 * 60 * 1_000,
  );
});
