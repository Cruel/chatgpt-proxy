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

export interface SubmittedConversationRecoveryOptions {
  readonly navigationTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly stableContentMs: number;
}

interface ConversationTurnSnapshot {
  readonly count: number;
  readonly latestRole: "assistant" | "user" | null;
}

async function conversationTurnSnapshot(
  page: Page,
): Promise<ConversationTurnSnapshot> {
  const turns = page.locator(
    '[data-message-author-role="assistant"], [data-message-author-role="user"]',
  );
  const count = await turns.count();
  if (count === 0) {
    return { count, latestRole: null };
  }
  const role = await turns.nth(count - 1).getAttribute("data-message-author-role");
  return {
    count,
    latestRole: role === "assistant" || role === "user" ? role : null,
  };
}

async function waitForConversationTurnsToSettle(
  page: Page,
  options: SubmittedConversationRecoveryOptions,
): Promise<ConversationTurnSnapshot> {
  const deadline = Date.now() + options.navigationTimeoutMs;
  let snapshot = await conversationTurnSnapshot(page);
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(options.pollIntervalMs);
    const next = await conversationTurnSnapshot(page);
    if (
      next.count !== snapshot.count ||
      next.latestRole !== snapshot.latestRole
    ) {
      snapshot = next;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= options.stableContentMs) {
      return snapshot;
    }
  }

  return snapshot;
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

  if (context.signal.aborted) {
    return { ok: false, error: originalFailure };
  }

  const settledTurns = await waitForConversationTurnsToSettle(page, options);
  const observed = await captureSubmissionSnapshot(page);
  const responseAlreadyPresent = settledTurns.latestRole === "assistant";
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
    error: completion.error,
  };
}
