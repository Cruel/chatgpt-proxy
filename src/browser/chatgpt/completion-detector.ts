import type { Locator, Page } from "playwright";

import type {
  BrowserAdapterFailure,
  FinalAssistantResponse,
  RemoteConversationReference,
} from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import { detectBlockingFailure } from "./error-detector.js";
import {
  CHATGPT_SELECTORS,
  anyVisible,
  firstPopulatedCollection,
} from "./selectors.js";
import { conversationReferenceFromPage } from "./url.js";

export interface SubmissionSnapshot {
  readonly assistantTurnCount: number;
  readonly userTurnCount: number;
  readonly latestAssistantSignature: string | null;
  readonly url: string;
  readonly composerVisible: boolean;
}

export interface CompletionDetectorOptions {
  readonly responseTimeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly stableContentMs?: number;
  readonly onConversationIdentified?: (
    conversation: RemoteConversationReference,
  ) => void;
}

export type CompletionResult =
  | {
      readonly ok: true;
      readonly response: FinalAssistantResponse;
    }
  | {
      readonly ok: false;
      readonly error: BrowserAdapterFailure;
    };

function normalizeSignature(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim().slice(0, 2_000);
}

export async function turnSignature(turn: Locator): Promise<string | null> {
  const text = normalizeSignature(await turn.innerText().catch(() => ""));
  if (text.length === 0) {
    return null;
  }
  const messageId = await turn.getAttribute("data-message-id").catch(() => null);
  const testId = await turn.getAttribute("data-testid").catch(() => null);
  return `${messageId ?? testId ?? ""}:${text}`;
}

export async function extractAssistantTurnText(turn: Locator): Promise<string> {
  return turn.evaluate(
    (element, selectors) => {
      const contentSelectors = selectors.messageContent;
      let source: Element = element;
      for (const selector of contentSelectors) {
        const candidates = element.querySelectorAll(selector);
        const candidate = candidates.item(candidates.length - 1);
        if (candidate !== null && candidates.length > 0) {
          source = candidate;
          break;
        }
      }

      const clone = source.cloneNode(true) as HTMLElement;
      const removableSelectors = [
        "button",
        "svg",
        "script",
        "style",
        "[aria-live]",
        ...selectors.toolProgress,
      ];
      for (const selector of removableSelectors) {
        for (const removable of clone.querySelectorAll(selector)) {
          removable.remove();
        }
      }
      const container = document.createElement("div");
      container.style.position = "fixed";
      container.style.left = "-100000px";
      container.style.top = "0";
      container.append(clone);
      document.body.append(container);
      const text = container.innerText;
      container.remove();
      return text;
    },
    {
      messageContent: [...CHATGPT_SELECTORS.messageContent],
      toolProgress: [...CHATGPT_SELECTORS.toolProgress],
    },
  ).then((value) =>
    value
      .replaceAll(/\r\n/g, "\n")
      .replaceAll(/[ \t]+\n/g, "\n")
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

async function extractAssistantTurnUsingCopy(
  page: Page,
  turn: Locator,
): Promise<string | null> {
  const copy = turn.locator('[data-testid="copy-turn-action-button"]').first();
  if (!(await copy.isVisible().catch(() => false))) {
    return null;
  }

  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await copy.click();
    await page.waitForTimeout(150);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const normalized = copied.trim();
    return normalized.length === 0 ? null : normalized;
  } catch {
    return null;
  }
}

export async function captureSubmissionSnapshot(
  page: Page,
): Promise<SubmissionSnapshot> {
  const assistantTurns = await firstPopulatedCollection(
    page,
    CHATGPT_SELECTORS.assistantTurns,
  );
  const userTurns = await firstPopulatedCollection(page, CHATGPT_SELECTORS.userTurns);
  const assistantTurnCount = await assistantTurns.count();
  const latestAssistantSignature =
    assistantTurnCount === 0
      ? null
      : await turnSignature(assistantTurns.nth(assistantTurnCount - 1));
  return {
    assistantTurnCount,
    userTurnCount: await userTurns.count(),
    latestAssistantSignature,
    url: page.url(),
    composerVisible: await anyVisible(page, CHATGPT_SELECTORS.composer),
  };
}

function timeoutFailure(page: Page): BrowserAdapterFailure {
  return {
    code: "response_timeout",
    message: "Timed out waiting for ChatGPT to produce a final response",
    retryable: true,
    observedUrl: page.isClosed() ? null : page.url(),
  };
}

async function targetAssistantTurn(
  page: Page,
  snapshot: SubmissionSnapshot,
): Promise<Locator | null> {
  const turns = await firstPopulatedCollection(page, CHATGPT_SELECTORS.assistantTurns);
  const count = await turns.count();
  if (count > snapshot.assistantTurnCount) {
    return turns.nth(count - 1);
  }
  if (count === 0) {
    return null;
  }

  const last = turns.nth(count - 1);
  const signature = await turnSignature(last);
  return signature !== null && signature !== snapshot.latestAssistantSignature
    ? last
    : null;
}

export async function waitForFinalAssistantResponse(
  page: Page,
  manager: BrowserManager,
  snapshot: SubmissionSnapshot,
  fallbackConversation: RemoteConversationReference | null,
  options: CompletionDetectorOptions,
): Promise<CompletionResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const stableContentMs = options.stableContentMs ?? 1_250;
  const deadline = Date.now() + options.responseTimeoutMs;
  let stableText = "";
  let stableSince = Date.now();
  let identifiedConversationId = fallbackConversation?.conversationId ?? null;

  while (Date.now() < deadline) {
    const blockingFailure = await detectBlockingFailure(page, manager);
    if (blockingFailure !== null) {
      return { ok: false, error: blockingFailure };
    }

    const observedConversation = await conversationReferenceFromPage(page);
    if (
      observedConversation !== null &&
      observedConversation.conversationId !== identifiedConversationId
    ) {
      identifiedConversationId = observedConversation.conversationId;
      options.onConversationIdentified?.(observedConversation);
    }

    const target = await targetAssistantTurn(page, snapshot);
    if (target !== null) {
      const text = await extractAssistantTurnText(target);
      const generationActive = await anyVisible(
        page,
        CHATGPT_SELECTORS.generationControl,
      );
      const toolActive = await anyVisible(target, CHATGPT_SELECTORS.toolProgress);
      const copyVisible = await anyVisible(target, CHATGPT_SELECTORS.copyControl);

      if (text !== stableText) {
        stableText = text;
        stableSince = Date.now();
      }

      if (
        text.length > 0 &&
        !generationActive &&
        !toolActive &&
        (copyVisible || Date.now() - stableSince >= stableContentMs)
      ) {
        const conversation = observedConversation ?? fallbackConversation;
        if (conversation === null) {
          return {
            ok: false,
            error: {
              code: "submission_ambiguous",
              message:
                "ChatGPT completed a response but the conversation URL could not be identified",
              retryable: false,
              observedUrl: page.url(),
            },
          };
        }
        const copiedText = copyVisible
          ? await extractAssistantTurnUsingCopy(page, target)
          : null;
        return {
          ok: true,
          response: { text: copiedText ?? text, conversation },
        };
      }
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  return { ok: false, error: timeoutFailure(page) };
}
