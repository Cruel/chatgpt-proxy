import type { Locator, Page } from "playwright";

export const CHATGPT_SELECTORS = {
  composer: [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][role="textbox"]',
  ],
  sendButton: [
    '[data-testid="send-button"]',
    'button[aria-label*="Send prompt"]',
    'button[aria-label="Send"]',
    'button:has-text("Send")',
  ],
  newChatAction: [
    'main [data-testid="project-new-chat-button"]',
    'main [data-testid="new-chat-button"]',
    'main a[aria-label*="New chat"]',
    'main button[aria-label*="New chat"]',
    'main a:has-text("New chat")',
    'main button:has-text("New chat")',
    'main button:has-text("Start a new chat")',
  ],
  conversationActionMenu: [
    '[data-testid="conversation-options-button"]',
    'button[aria-label="Open conversation options"]',
    'button[aria-label^="Open conversation options for "]',
  ],
  deleteMenuItem: [
    '[data-testid="delete-chat-menu-item"]',
    '[role="menuitem"]:has-text("Delete")',
  ],
  deleteConfirmationDialog: [
    '[role="dialog"]:has([data-testid="delete-conversation-confirm-button"])',
    '[role="dialog"]:has-text("Delete chat")',
    '[role="dialog"]:has-text("Delete conversation")',
  ],
  deleteConfirmButton: [
    '[data-testid="delete-conversation-confirm-button"]',
    'button:has-text("Delete")',
  ],
  deleteCancelButton: [
    'button:has-text("Cancel")',
  ],
  assistantTurns: [
    '[data-message-author-role="assistant"]',
    'article[data-testid="assistant-turn"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  ],
  userTurns: [
    '[data-message-author-role="user"]',
    'article[data-testid="user-turn"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  ],
  messageContent: [
    '[data-testid="message-content"]',
    "[data-message-content]",
    ".markdown",
    ".prose",
  ],
  copyControl: [
    '[data-testid="copy-turn-action-button"]',
    'button[aria-label^="Copy"]',
    'button:has-text("Copy")',
  ],
  generationControl: [
    '[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label="Stop"]',
    'button:has-text("Stop generating")',
  ],
  toolProgress: [
    '[data-testid="tool-progress"]',
    '[data-testid*="tool-status"]',
    '[data-testid*="research-progress"]',
    '[data-testid*="reasoning"]',
    '[aria-busy="true"]',
  ],
  loginAction: [
    'a[href*="/auth/login"]',
    'button:has-text("Log in")',
    'a:has-text("Log in")',
    'button:has-text("Sign up")',
    'a:has-text("Sign up")',
  ],
  verification: [
    'iframe[src*="challenges.cloudflare.com"]',
    '[data-testid="challenge-stage"]',
    'text=/just a moment/i',
    'text=/performing security verification/i',
    'text=/enable javascript and cookies to continue/i',
    'text=/verify (you are|that you are) human/i',
    'text=/checking your browser/i',
    'text=/security verification/i',
  ],
  missingConversation: [
    '[data-testid="conversation-missing"]',
    'text=/conversation (was not found|not found|does not exist)/i',
    'text=/unable to load conversation/i',
  ],
  alert: ['[role="alert"]'],
  confirmationDialog: [
    '[role="dialog"][aria-modal="true"]',
    '[data-testid*="confirmation-dialog"]',
  ],
} as const;

export interface LocatorRoot {
  locator(selector: string): Locator;
}

export type ChatGptSelectorGroup = keyof typeof CHATGPT_SELECTORS;

export interface MatchedSelector {
  readonly group: ChatGptSelectorGroup;
  readonly selector: string;
  readonly count: number;
  readonly visibleCount: number;
}

export class ChatGptSelectorRegistry {
  public selectors(group: ChatGptSelectorGroup): readonly string[] {
    return CHATGPT_SELECTORS[group];
  }

  public async firstVisible(
    root: LocatorRoot,
    group: ChatGptSelectorGroup,
  ): Promise<Locator | null> {
    for (const selector of this.selectors(group)) {
      const locator = root.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    return null;
  }

  public async collectVisibleMatches(
    root: LocatorRoot,
    groups: readonly ChatGptSelectorGroup[] = Object.keys(
      CHATGPT_SELECTORS,
    ) as ChatGptSelectorGroup[],
  ): Promise<readonly MatchedSelector[]> {
    const matches: MatchedSelector[] = [];
    for (const group of groups) {
      for (const selector of this.selectors(group)) {
        const locators = root.locator(selector);
        const count = await locators.count().catch(() => 0);
        if (count === 0) {
          continue;
        }
        let visibleCount = 0;
        for (let index = 0; index < Math.min(count, 25); index += 1) {
          if (await locators.nth(index).isVisible().catch(() => false)) {
            visibleCount += 1;
          }
        }
        if (visibleCount > 0) {
          matches.push({ group, selector, count, visibleCount });
        }
      }
    }
    return matches;
  }
}

export const CHATGPT_SELECTOR_REGISTRY = new ChatGptSelectorRegistry();

export function firstLocator(
  root: LocatorRoot,
  selectors: readonly string[],
): Locator {
  let combined = root.locator(selectors[0] ?? ":not(*)");
  for (const selector of selectors.slice(1)) {
    combined = combined.or(root.locator(selector));
  }
  return combined.first();
}

export async function firstVisibleLocator(
  root: LocatorRoot,
  selectors: readonly string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = root.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

export async function waitForVisibleLocator(
  root: LocatorRoot,
  selectors: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly pollIntervalMs?: number;
  },
): Promise<Locator | null> {
  const deadline = Date.now() + options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  while (Date.now() < deadline) {
    const locator = await firstVisibleLocator(root, selectors);
    if (locator !== null) {
      return locator;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return firstVisibleLocator(root, selectors);
}

export async function anyVisible(
  root: LocatorRoot,
  selectors: readonly string[],
): Promise<boolean> {
  return (await firstVisibleLocator(root, selectors)) !== null;
}

export async function firstPopulatedCollection(
  page: Page,
  selectors: readonly string[],
): Promise<Locator> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if ((await locator.count()) > 0) {
      return locator;
    }
  }
  return page.locator(selectors[0] ?? ":not(*)");
}
