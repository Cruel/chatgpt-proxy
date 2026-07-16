import type { Page } from "playwright";

import type {
  BrowserAdapterFailure,
  BrowserOperationContext,
  RemoteConversationReference,
} from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import {
  captureSubmissionSnapshot,
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
    };

function failure(
  page: Page,
  code: BrowserAdapterFailure["code"],
  message: string,
  retryable: boolean,
): MessageSubmissionResult {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      observedUrl: page.isClosed() ? null : page.url(),
    },
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
    );
  }

  const composer = await firstVisibleLocator(page, CHATGPT_SELECTORS.composer);
  if (composer === null) {
    return failure(page, "input_not_found", "Message composer not found", false);
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
    );
  }

  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + options.submissionTimeoutMs;
  while (Date.now() < deadline) {
    const blockingFailure = await detectBlockingFailure(page, manager);
    if (blockingFailure !== null) {
      return { ok: false, error: blockingFailure };
    }

    const userTurns = await firstPopulatedCollection(page, CHATGPT_SELECTORS.userTurns);
    const assistantTurns = await firstPopulatedCollection(
      page,
      CHATGPT_SELECTORS.assistantTurns,
    );
    const conversation = await conversationReferenceFromPage(page);
    const confirmed =
      (await userTurns.count()) > snapshot.userTurnCount ||
      (await assistantTurns.count()) > snapshot.assistantTurnCount ||
      (conversation !== null && page.url() !== snapshot.url);
    if (confirmed) {
      if (conversation !== null) {
        context.onConversationIdentified?.(conversation);
      }
      return { ok: true, snapshot, conversation };
    }

    if (context.signal.aborted) {
      return failure(
        page,
        "submission_ambiguous",
        "The operation was aborted after submission was attempted",
        false,
      );
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  return failure(
    page,
    "submission_ambiguous",
    "The message may have been submitted, but ChatGPT did not confirm it",
    false,
  );
}
