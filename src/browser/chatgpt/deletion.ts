import type { Locator, Page } from "playwright";

import type {
  BrowserAdapterFailure,
  BrowserAdapterResult,
  BrowserOperationContext,
  RemoteConversationReference,
  RemoteDeletionResult,
} from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import { detectBlockingFailure } from "./error-detector.js";
import {
  CHATGPT_SELECTORS,
  firstVisibleLocator,
} from "./selectors.js";
import { extractConversationId } from "./url.js";

interface RemoteDeletionOptions {
  readonly navigationTimeoutMs: number;
  readonly pollIntervalMs: number;
}

type ConversationPresence =
  | {
      readonly state: "present" | "absent" | "unknown";
      readonly evidence: readonly string[];
    }
  | {
      readonly state: "blocked";
      readonly evidence: readonly string[];
      readonly failure: BrowserAdapterFailure;
    };

function failure(
  page: Page,
  code: BrowserAdapterFailure["code"],
  message: string,
  retryable: boolean,
): BrowserAdapterFailure {
  return {
    code,
    message,
    retryable,
    observedUrl: page.isClosed() ? null : page.url(),
  };
}

async function navigate(
  page: Page,
  url: string,
  timeoutMs: number,
): Promise<BrowserAdapterFailure | null> {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      page,
      "navigation_failed",
      `Failed to navigate to the ChatGPT conversation: ${detail}`,
      true,
    );
  }
}

async function inspectConversationPresence(
  page: Page,
  manager: BrowserManager,
  conversation: RemoteConversationReference,
  options: RemoteDeletionOptions,
): Promise<ConversationPresence> {
  const navigationFailure = await navigate(
    page,
    conversation.url,
    options.navigationTimeoutMs,
  );
  if (navigationFailure !== null) {
    return {
      state: "blocked",
      evidence: [navigationFailure.message],
      failure: navigationFailure,
    };
  }

  const deadline = Date.now() + options.navigationTimeoutMs;
  const presentStabilityMs = Math.min(1_000, options.navigationTimeoutMs / 4);
  let presentCandidateSince: number | null = null;
  while (!page.isClosed() && Date.now() < deadline) {
    const blockingFailure = await detectBlockingFailure(page, manager);
    if (blockingFailure !== null) {
      if (blockingFailure.code === "thread_not_found") {
        return {
          state: "absent",
          evidence: [
            "ChatGPT displayed a missing-conversation state",
            `observed URL: ${page.url()}`,
          ],
        };
      }
      return {
        state: "blocked",
        evidence: [blockingFailure.message],
        failure: blockingFailure,
      };
    }

    const observedConversationId = extractConversationId(page.url());
    if (observedConversationId !== conversation.conversationId) {
      return {
        state: "absent",
        evidence: [
          observedConversationId === null
            ? "ChatGPT redirected away from any conversation URL"
            : `ChatGPT redirected to conversation '${observedConversationId}'`,
          `observed URL: ${page.url()}`,
        ],
      };
    }

    const composer = await firstVisibleLocator(page, CHATGPT_SELECTORS.composer);
    const currentConversationMenu = await firstVisibleLocator(page, [
      '[data-testid="conversation-options-button"]',
      'button[aria-label="Open conversation options"]',
    ]);
    if (composer !== null && currentConversationMenu !== null) {
      presentCandidateSince ??= Date.now();
    } else {
      presentCandidateSince = null;
    }
    if (
      presentCandidateSince !== null &&
      Date.now() - presentCandidateSince >= presentStabilityMs
    ) {
      return {
        state: "present",
        evidence: [
          `conversation '${conversation.conversationId}' remained loadable`,
          "the exact conversation URL, composer, and current-conversation action menu remained stable",
        ],
      };
    }

    await page.waitForTimeout(options.pollIntervalMs);
  }

  return {
    state: "unknown",
    evidence: [
      `conversation '${conversation.conversationId}' did not reach a conclusive present or absent state`,
      `observed URL: ${page.isClosed() ? "page closed" : page.url()}`,
    ],
  };
}

async function waitForVisible(
  page: Page,
  selectors: readonly string[],
  deadline: number,
  pollIntervalMs: number,
): Promise<Locator | null> {
  while (!page.isClosed() && Date.now() < deadline) {
    const locator = await firstVisibleLocator(page, selectors);
    if (locator !== null) {
      return locator;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  return null;
}

async function conversationActionMenu(
  page: Page,
  conversation: RemoteConversationReference,
): Promise<Locator | null> {
  const headerMenu = await firstVisibleLocator(
    page,
    CHATGPT_SELECTORS.conversationActionMenu,
  );
  if (headerMenu !== null) {
    return headerMenu;
  }

  const conversationSpecific = page
    .locator(
      `[data-conversation-options-trigger="${conversation.conversationId}"]`,
    )
    .first();
  return (await conversationSpecific.isVisible().catch(() => false))
    ? conversationSpecific
    : null;
}

function dialogLooksLikeDeletion(text: string): boolean {
  const normalized = text.replaceAll(/\s+/g, " ").trim().toLowerCase();
  return (
    normalized.includes("delete chat") ||
    normalized.includes("delete conversation")
  );
}

export async function deleteRemoteConversation(
  page: Page,
  manager: BrowserManager,
  conversation: RemoteConversationReference,
  context: BrowserOperationContext,
  options: RemoteDeletionOptions,
): Promise<BrowserAdapterResult<RemoteDeletionResult>> {
  const initialPresence = await inspectConversationPresence(
    page,
    manager,
    conversation,
    options,
  );
  if (initialPresence.state === "absent") {
    return {
      ok: true,
      value: {
        outcome: "already_absent",
        evidence: initialPresence.evidence,
      },
    };
  }
  if (initialPresence.state === "blocked") {
    return { ok: false, error: initialPresence.failure };
  }
  if (initialPresence.state === "unknown") {
    return {
      ok: false,
      error: failure(
        page,
        "ui_changed",
        "The conversation did not expose a conclusive load state before deletion",
        false,
      ),
    };
  }

  const deadline = Date.now() + options.navigationTimeoutMs;
  let actionMenu = await conversationActionMenu(page, conversation);
  while (
    actionMenu === null &&
    !page.isClosed() &&
    Date.now() < deadline &&
    !context.signal.aborted
  ) {
    await page.waitForTimeout(options.pollIntervalMs);
    actionMenu = await conversationActionMenu(page, conversation);
  }
  if (actionMenu === null) {
    return {
      ok: false,
      error: failure(
        page,
        "ui_changed",
        "The ChatGPT conversation did not expose a known conversation action menu",
        false,
      ),
    };
  }

  try {
    await actionMenu.click({ timeout: Math.max(1, deadline - Date.now()) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: failure(
        page,
        "remote_delete_failed",
        `Failed to open the ChatGPT conversation action menu: ${detail}`,
        true,
      ),
    };
  }

  const deleteMenuItem = await waitForVisible(
    page,
    CHATGPT_SELECTORS.deleteMenuItem,
    deadline,
    options.pollIntervalMs,
  );
  if (deleteMenuItem === null) {
    return {
      ok: false,
      error: failure(
        page,
        "ui_changed",
        "The ChatGPT conversation action menu did not expose a known Delete action",
        false,
      ),
    };
  }

  try {
    await deleteMenuItem.click({ timeout: Math.max(1, deadline - Date.now()) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: failure(
        page,
        "remote_delete_failed",
        `Failed to open the ChatGPT deletion confirmation: ${detail}`,
        true,
      ),
    };
  }

  const dialog = await waitForVisible(
    page,
    CHATGPT_SELECTORS.deleteConfirmationDialog,
    deadline,
    options.pollIntervalMs,
  );
  if (dialog === null) {
    return {
      ok: false,
      error: failure(
        page,
        "remote_delete_failed",
        "ChatGPT did not display a recognizable deletion confirmation dialog",
        false,
      ),
    };
  }

  const dialogText = (await dialog.innerText().catch(() => "")).trim();
  const confirmButton = await firstVisibleLocator(
    dialog,
    CHATGPT_SELECTORS.deleteConfirmButton,
  );
  const cancelButton = await firstVisibleLocator(
    dialog,
    CHATGPT_SELECTORS.deleteCancelButton,
  );
  if (
    !dialogLooksLikeDeletion(dialogText) ||
    confirmButton === null ||
    cancelButton === null
  ) {
    return {
      ok: false,
      error: failure(
        page,
        "remote_delete_failed",
        "The confirmation dialog could not be validated as a ChatGPT conversation deletion",
        false,
      ),
    };
  }

  const evidence = [
    "conversation action menu opened",
    "Delete menu item selected",
    `validated confirmation dialog: ${dialogText.replaceAll(/\s+/g, " ").slice(0, 240)}`,
  ];

  let clickDetail: string | null = null;
  try {
    await confirmButton.click({
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch (error) {
    clickDetail = error instanceof Error ? error.message : String(error);
  }

  if (!page.isClosed()) {
    await page.waitForTimeout(
      Math.min(1_000, Math.max(options.pollIntervalMs, options.navigationTimeoutMs)),
    );
  }

  const verification = await inspectConversationPresence(
    page,
    manager,
    conversation,
    options,
  );
  if (verification.state === "absent") {
    return {
      ok: true,
      value: {
        outcome: "deleted",
        evidence: [
          ...evidence,
          ...(clickDetail === null
            ? ["Delete confirmation was clicked"]
            : [`Delete click reported an error but absence was verified: ${clickDetail}`]),
          ...verification.evidence,
        ],
      },
    };
  }

  return {
    ok: true,
    value: {
      outcome: "ambiguous",
      evidence: [
        ...evidence,
        ...(clickDetail === null
          ? ["Delete confirmation was clicked"]
          : [`Delete confirmation click was inconclusive: ${clickDetail}`]),
        ...verification.evidence,
        ...(verification.state === "blocked"
          ? [`verification was blocked: ${verification.failure.message}`]
          : []),
      ],
    },
  };
}
