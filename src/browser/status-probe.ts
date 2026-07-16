import type { Page } from "playwright";

import type { BrowserStatus } from "../domain/states.js";

export type ObservableBrowserStatus = Extract<
  BrowserStatus,
  "ready" | "auth_required" | "verification_required" | "unavailable"
>;

export interface BrowserStatusObservation {
  readonly status: ObservableBrowserStatus;
  readonly detail: string | null;
}

export interface BrowserStatusProbe {
  inspect(page: Page): Promise<BrowserStatusObservation>;
}

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

export class ChatGptAuthenticationProbe implements BrowserStatusProbe {
  public async inspect(page: Page): Promise<BrowserStatusObservation> {
    if (page.isClosed()) {
      return { status: "unavailable", detail: "Browser page is closed" };
    }

    const url = page.url();
    const lowerUrl = url.toLowerCase();
    const title = (await page.title().catch(() => "")).trim().toLowerCase();
    const verificationVisible = await anyVisible(page, [
      'iframe[src*="challenges.cloudflare.com"]',
      '[data-testid="challenge-stage"]',
      'text=/just a moment/i',
      'text=/performing security verification/i',
      'text=/enable javascript and cookies to continue/i',
      'text=/verify (you are|that you are) human/i',
      'text=/checking your browser/i',
      'text=/security verification/i',
    ]);
    if (
      verificationVisible ||
      title === "just a moment..." ||
      title === "just a moment…" ||
      lowerUrl.includes("challenge") ||
      lowerUrl.includes("captcha")
    ) {
      return {
        status: "verification_required",
        detail: "ChatGPT requires interactive browser verification",
      };
    }

    const pathname = (() => {
      try {
        return new URL(url).pathname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const loginVisible = await anyVisible(page, [
      'a[href*="/auth/login"]',
      'button:has-text("Log in")',
      'a:has-text("Log in")',
      'button:has-text("Sign up")',
      'a:has-text("Sign up")',
    ]);
    if (
      loginVisible ||
      pathname.includes("/auth/login") ||
      pathname.includes("/auth0/")
    ) {
      return {
        status: "auth_required",
        detail: "ChatGPT login is required in the persistent browser profile",
      };
    }

    const authenticatedControlVisible = await anyVisible(page, [
      "#prompt-textarea",
      '[data-testid="prompt-textarea"]',
      'textarea[placeholder*="Message"]',
      '[contenteditable="true"][role="textbox"]',
      '[data-testid="new-chat-button"]',
      'button[aria-label*="New chat"]',
      'a[aria-label*="New chat"]',
    ]);
    if (authenticatedControlVisible) {
      return { status: "ready", detail: null };
    }

    return {
      status: "unavailable",
      detail: `Unable to verify ChatGPT login state at ${url}`,
    };
  }
}
