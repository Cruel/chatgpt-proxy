import type { Page } from "playwright";

import type {
  BrowserAdapterFailure,
  BrowserAdapterResult,
  BrowserOperationContext,
  FinalAssistantResponse,
  RemoteConversationReference,
} from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import {
  captureSubmissionSnapshot,
  waitForFinalAssistantResponse,
} from "./completion-detector.js";
import { openExistingConversation } from "./project-navigation.js";
import {
  CHATGPT_SELECTORS,
  firstPopulatedCollection,
} from "./selectors.js";

function normalizeMessage(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

async function latestUserText(page: Page): Promise<string | null> {
  const turns = await firstPopulatedCollection(page, CHATGPT_SELECTORS.userTurns);
  const count = await turns.count();
  if (count === 0) {
    return null;
  }
  const text = normalizeMessage(
    await turns.nth(count - 1).innerText().catch(() => ""),
  );
  return text.length === 0 ? null : text;
}

export interface SubmittedConversationRecoveryOptions {
  readonly navigationTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly stableContentMs: number;
}

/**
 * Recovers only by inspecting a known conversation. It never resubmits the
 * prompt, so an ambiguous click or interrupted response cannot duplicate a
 * remote user turn.
 */
export async function recoverSubmittedConversation(
  page: Page,
  manager: BrowserManager,
  conversation: RemoteConversationReference,
  expectedMessage: string,
  originalFailure: BrowserAdapterFailure,
  context: BrowserOperationContext,
  options: SubmittedConversationRecoveryOptions,
): Promise<BrowserAdapterResult<FinalAssistantResponse>> {
  const navigationFailure = await openExistingConversation(page, manager, {
    url: conversation.url,
    conversationId: conversation.conversationId,
    navigationTimeoutMs: options.navigationTimeoutMs,
  });
  if (navigationFailure !== null) {
    return { ok: false, error: navigationFailure };
  }

  const normalizedExpectedMessage = normalizeMessage(expectedMessage);
  const verificationDeadline = Date.now() + options.navigationTimeoutMs;
  let observedUserText = await latestUserText(page);
  while (
    observedUserText !== normalizedExpectedMessage &&
    Date.now() < verificationDeadline
  ) {
    if (context.signal.aborted) {
      return { ok: false, error: originalFailure };
    }
    await page.waitForTimeout(options.pollIntervalMs);
    observedUserText = await latestUserText(page);
  }
  if (observedUserText !== normalizedExpectedMessage) {
    return { ok: false, error: originalFailure };
  }

  const observed = await captureSubmissionSnapshot(page);
  const responseAlreadyPresent =
    observed.assistantTurnCount >= observed.userTurnCount &&
    observed.assistantTurnCount > 0;
  const recoverySnapshot = responseAlreadyPresent
    ? {
        ...observed,
        latestAssistantSignature: "__chatgpt_proxy_recovery_target__",
      }
    : observed;

  const completion = await waitForFinalAssistantResponse(
    page,
    manager,
    recoverySnapshot,
    conversation,
    {
      responseTimeoutMs: options.responseTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      stableContentMs: options.stableContentMs,
      ...(context.onConversationIdentified === undefined
        ? {}
        : { onConversationIdentified: context.onConversationIdentified }),
    },
  );
  if (completion.ok) {
    return { ok: true, value: completion.response };
  }
  return {
    ok: false,
    error:
      completion.error.code === "response_timeout"
        ? originalFailure
        : completion.error,
  };
}
