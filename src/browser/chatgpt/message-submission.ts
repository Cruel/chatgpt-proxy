import type { Page } from "playwright";

import type {
  BrowserAdapterFailure,
  BrowserOperationContext,
  RemoteConversationReference,
} from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import {
  captureSubmissionSnapshot,
  turnSignature,
  type SubmissionSnapshot,
} from "./completion-detector.js";
import { detectBlockingFailure } from "./error-detector.js";
import {
  CHATGPT_SELECTORS,
  firstPopulatedCollection,
  firstVisibleLocator,
} from "./selectors.js";
import { conversationReferenceFromPage } from "./url.js";

export interface MessageSubmissionOptions {
  readonly submissionTimeoutMs: number;
  readonly pollIntervalMs?: number;
}

export type MessageSubmissionResult =
  | {
      readonly ok: true;
      readonly snapshot: SubmissionSnapshot;
      readonly conversation: RemoteConversationReference | null;
    }
  | {
      readonly ok: false;
      readonly error: BrowserAdapterFailure;
      readonly snapshot: SubmissionSnapshot;
      readonly conversation: RemoteConversationReference | null;
    };

function normalizeMessageText(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function failure(
  page: Page,
  code: BrowserAdapterFailure["code"],
  message: string,
  retryable: boolean,
  snapshot: SubmissionSnapshot,
  conversation: RemoteConversationReference | null = null,
): MessageSubmissionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      observedUrl: page.isClosed() ? null : page.url(),
    },
    snapshot,
    conversation,
  };
}

export async function submitMessage(
  page: Page,
  manager: BrowserManager,
  message: string,
  context: BrowserOperationContext,
  options: MessageSubmissionOptions,
): Promise<MessageSubmissionResult> {
  const snapshot = await captureSubmissionSnapshot(page);
  if (!snapshot.composerVisible) {
    return failure(
      page,
      "input_not_found",
      "The ChatGPT message composer is not available",
      false,
      snapshot,
    );
  }

  const composer = await firstVisibleLocator(page, CHATGPT_SELECTORS.composer);
  if (composer === null) {
    return failure(
      page,
      "input_not_found",
      "Message composer not found",
      false,
      snapshot,
    );
  }

  try {
    await composer.fill(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      page,
      "send_failed",
      `Failed to enter the ChatGPT message: ${detail}`,
      true,
      snapshot,
    );
  }

  let submitAttempted = false;
  try {
    const sendButton = await firstVisibleLocator(page, CHATGPT_SELECTORS.sendButton);
    if (sendButton !== null && (await sendButton.isEnabled().catch(() => false))) {
      submitAttempted = true;
      await sendButton.click();
    } else {
      submitAttempted = true;
      await composer.press("Enter");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure(
      page,
      submitAttempted ? "submission_ambiguous" : "send_failed",
      `Failed while submitting the ChatGPT message: ${detail}`,
      submitAttempted,
      snapshot,
      await conversationReferenceFromPage(page),
    );
  }

  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + options.submissionTimeoutMs;
  let latestConversation: RemoteConversationReference | null = null;
  while (Date.now() < deadline) {
    const blockingFailure = await detectBlockingFailure(page, manager);
    if (blockingFailure !== null) {
      return {
        ok: false,
        error: blockingFailure,
        snapshot,
        conversation: latestConversation,
      };
    }

    const userTurns = await firstPopulatedCollection(page, CHATGPT_SELECTORS.userTurns);
    const assistantTurns = await firstPopulatedCollection(
      page,
      CHATGPT_SELECTORS.assistantTurns,
    );
    const conversation = await conversationReferenceFromPage(page);
    if (
      conversation !== null &&
      conversation.conversationId !== latestConversation?.conversationId
    ) {
      latestConversation = conversation;
      context.onConversationIdentified?.(conversation);
    }
    const userTurnCount = await userTurns.count();
    const assistantTurnCount = await assistantTurns.count();
    const confirmed =
      userTurnCount > snapshot.userTurnCount ||
      assistantTurnCount > snapshot.assistantTurnCount ||
      (conversation !== null && page.url() !== snapshot.url);
    const latestUserText =
      userTurnCount === 0
        ? ""
        : normalizeMessageText(
            await userTurns
              .nth(userTurnCount - 1)
              .innerText()
              .catch(() => ""),
          );
    const latestAssistantSignature =
      assistantTurnCount === 0
        ? null
        : await turnSignature(assistantTurns.nth(assistantTurnCount - 1));
    const submittedMessageVisible =
      latestUserText === normalizeMessageText(message);
    const assistantTurnChanged =
      latestAssistantSignature !== null &&
      latestAssistantSignature !== snapshot.latestAssistantSignature;
    if (confirmed || submittedMessageVisible || assistantTurnChanged) {
      if (conversation !== null) {
        latestConversation = conversation;
      }
      return { ok: true, snapshot, conversation: latestConversation };
    }

    if (context.signal.aborted) {
      return failure(
        page,
        "submission_ambiguous",
        "The operation was aborted after submission was attempted",
        false,
        snapshot,
        latestConversation,
      );
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  return failure(
    page,
    "submission_ambiguous",
    "The message may have been submitted, but ChatGPT did not confirm it",
    false,
    snapshot,
    latestConversation,
  );
}
