import type { Page } from "playwright";

import type { BrowserAdapterFailure } from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import { matchKnownAlert } from "./known-detectors.js";
import {
  CHATGPT_SELECTORS,
  anyVisible,
  firstVisibleLocator,
} from "./selectors.js";

function failure(
  code: BrowserAdapterFailure["code"],
  message: string,
  page: Page,
  retryable = false,
): BrowserAdapterFailure {
  return {
    code,
    message,
    retryable,
    observedUrl: page.isClosed() ? null : page.url(),
  };
}

async function visibleText(page: Page, selectors: readonly string[]): Promise<string> {
  const locator = await firstVisibleLocator(page, selectors);
  return locator === null
    ? ""
    : ((await locator.innerText().catch(() => "")) ?? "").trim();
}

export async function detectBlockingFailure(
  page: Page,
  manager: BrowserManager,
): Promise<BrowserAdapterFailure | null> {
  if (page.isClosed()) {
    return {
      code: "browser_crashed",
      message: "The browser page closed during the ChatGPT operation",
      retryable: true,
      observedUrl: null,
    };
  }

  if (await anyVisible(page, CHATGPT_SELECTORS.verification)) {
    await manager.reportPageStatus(page);
    return failure(
      "verification_required",
      "ChatGPT requires interactive browser verification",
      page,
      true,
    );
  }

  if (await anyVisible(page, CHATGPT_SELECTORS.loginAction)) {
    await manager.reportPageStatus(page);
    return failure(
      "auth_required",
      "ChatGPT login is required in the persistent browser profile",
      page,
      true,
    );
  }

  if (await anyVisible(page, CHATGPT_SELECTORS.missingConversation)) {
    return failure(
      "thread_not_found",
      "The ChatGPT conversation does not exist or is no longer accessible",
      page,
    );
  }

  const alertText = await visibleText(page, CHATGPT_SELECTORS.alert);
  const knownAlert = matchKnownAlert(alertText);
  if (knownAlert !== null) {
    return failure(
      knownAlert.code,
      alertText || `ChatGPT matched the '${knownAlert.name}' detector`,
      page,
      knownAlert.retryable,
    );
  }

  const dialog = await firstVisibleLocator(page, CHATGPT_SELECTORS.confirmationDialog);
  if (dialog !== null) {
    const dialogText = (await dialog.innerText().catch(() => "")).trim();
    return failure(
      "needs_confirmation",
      dialogText.length === 0
        ? "ChatGPT requires confirmation before continuing"
        : `ChatGPT requires confirmation: ${dialogText}`,
      page,
    );
  }

  return null;
}
