import type { Locator, Page } from "playwright";

import type { BrowserAdapterFailure } from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import { detectBlockingFailure } from "./error-detector.js";
import {
  CHATGPT_SELECTORS,
  firstVisibleLocator,
} from "./selectors.js";
import {
  extractConversationId,
  isConfiguredProjectUrl,
} from "./url.js";

function navigationFailure(
  page: Page,
  message: string,
): BrowserAdapterFailure {
  return {
    code: "navigation_failed",
    message,
    retryable: true,
    observedUrl: page.isClosed() ? null : page.url(),
  };
}

const NAVIGATION_POLL_INTERVAL_MS = 100;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface NavigationControls {
  readonly composer: Locator | null;
  readonly newChat: Locator | null;
  readonly failure: BrowserAdapterFailure | null;
}

async function waitForNavigationControls(
  page: Page,
  manager: BrowserManager,
  deadline: number,
  includeNewChat: boolean,
): Promise<NavigationControls> {
  while (true) {
    const blockingFailure = await detectBlockingFailure(page, manager);
    if (blockingFailure !== null) {
      return { composer: null, newChat: null, failure: blockingFailure };
    }

    const composer = await firstVisibleLocator(page, CHATGPT_SELECTORS.composer);
    if (composer !== null) {
      return { composer, newChat: null, failure: null };
    }

    if (includeNewChat) {
      const newChat = await firstVisibleLocator(
        page,
        CHATGPT_SELECTORS.newChatAction,
      );
      if (newChat !== null) {
        return { composer: null, newChat, failure: null };
      }
    }

    if (Date.now() >= deadline || page.isClosed()) {
      return { composer: null, newChat: null, failure: null };
    }
    await delay(NAVIGATION_POLL_INTERVAL_MS);
  }
}

async function navigate(
  page: Page,
  url: string,
  navigationTimeoutMs: number,
): Promise<BrowserAdapterFailure | null> {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeoutMs,
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return navigationFailure(page, `Failed to navigate to ${url}: ${message}`);
  }
}

export async function openProjectForNewConversation(
  page: Page,
  manager: BrowserManager,
  input: {
    readonly projectUrl: string;
    readonly navigationTimeoutMs: number;
  },
): Promise<BrowserAdapterFailure | null> {
  const navigationError = await navigate(
    page,
    input.projectUrl,
    input.navigationTimeoutMs,
  );
  if (navigationError !== null) {
    return navigationError;
  }

  if (!isConfiguredProjectUrl(page.url(), input.projectUrl)) {
    return {
      code: "project_not_found",
      message: "Navigation did not remain within the configured ChatGPT project",
      retryable: false,
      observedUrl: page.url(),
    };
  }

  const deadline = Date.now() + input.navigationTimeoutMs;
  let controls = await waitForNavigationControls(page, manager, deadline, true);
  if (controls.failure !== null) {
    return controls.failure;
  }
  if (controls.newChat !== null) {
    try {
      await controls.newChat.click({
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        code: "navigation_failed",
        message: `Failed to activate a new project conversation: ${detail}`,
        retryable: true,
        observedUrl: page.url(),
      };
    }
    controls = await waitForNavigationControls(page, manager, deadline, false);
    if (controls.failure !== null) {
      return controls.failure;
    }
  }

  if (controls.composer === null) {
    return {
      code: "input_not_found",
      message: "The ChatGPT project page did not expose a message composer",
      retryable: false,
      observedUrl: page.url(),
    };
  }
  return null;
}

export async function openExistingConversation(
  page: Page,
  manager: BrowserManager,
  input: {
    readonly url: string;
    readonly conversationId: string;
    readonly navigationTimeoutMs: number;
  },
): Promise<BrowserAdapterFailure | null> {
  const navigationError = await navigate(page, input.url, input.navigationTimeoutMs);
  if (navigationError !== null) {
    return navigationError;
  }

  const observedConversationId = extractConversationId(page.url());
  if (observedConversationId === null) {
    return {
      code: "thread_not_found",
      message: "The loaded page is not a recognizable ChatGPT conversation URL",
      retryable: false,
      observedUrl: page.url(),
    };
  }
  if (observedConversationId !== input.conversationId) {
    return {
      code: "thread_not_found",
      message: `Expected conversation '${input.conversationId}' but loaded '${observedConversationId}'`,
      retryable: false,
      observedUrl: page.url(),
    };
  }

  const controls = await waitForNavigationControls(
    page,
    manager,
    Date.now() + input.navigationTimeoutMs,
    false,
  );
  if (controls.failure !== null) {
    return controls.failure;
  }
  if (controls.composer === null) {
    return {
      code: "input_not_found",
      message: "The ChatGPT conversation did not expose a message composer",
      retryable: false,
      observedUrl: page.url(),
    };
  }
  return null;
}
