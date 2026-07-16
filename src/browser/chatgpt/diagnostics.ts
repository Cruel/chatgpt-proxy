import type {
  ConsoleMessage,
  Page,
  Request,
} from "playwright";

import type {
  BrowserAdapterFailure,
  DiagnosticArtifactDraft,
} from "../adapter.js";
import type { BrowserManager } from "../manager.js";
import { extractAssistantTurnText } from "./completion-detector.js";
import {
  CHATGPT_SELECTOR_REGISTRY,
  CHATGPT_SELECTORS,
  firstPopulatedCollection,
  firstVisibleLocator,
} from "./selectors.js";

const MAX_LOG_ENTRIES = 100;
const MAX_TEXT_LENGTH = 20_000;
const MAX_DOM_FRAGMENT_LENGTH = 200_000;

function truncate(value: string, maximum = MAX_TEXT_LENGTH): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n…[truncated ${value.length - maximum} characters]`;
}

function textArtifact(
  type: Extract<DiagnosticArtifactDraft["type"], "html" | "dom_fragment">,
  mediaType: string,
  suggestedExtension: string,
  text: string,
): DiagnosticArtifactDraft {
  return {
    type,
    mediaType,
    suggestedExtension,
    data: new TextEncoder().encode(text),
  };
}

export interface PageDiagnosticObservation {
  readonly consoleErrors: readonly string[];
  readonly failedRequests: readonly string[];
  stop(): void;
}

export function observePageDiagnostics(page: Page): PageDiagnosticObservation {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  const onConsole = (message: ConsoleMessage) => {
    if (!["error", "warning"].includes(message.type())) {
      return;
    }
    if (consoleErrors.length < MAX_LOG_ENTRIES) {
      consoleErrors.push(
        truncate(`${message.type()}: ${message.text()}`, 4_000),
      );
    }
  };
  const onRequestFailed = (request: Request) => {
    if (failedRequests.length < MAX_LOG_ENTRIES) {
      const failure = request.failure();
      failedRequests.push(
        truncate(
          `${request.method()} ${request.url()} — ${failure?.errorText ?? "unknown failure"}`,
          4_000,
        ),
      );
    }
  };

  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  return {
    consoleErrors,
    failedRequests,
    stop() {
      page.off("console", onConsole);
      page.off("requestfailed", onRequestFailed);
    },
  };
}

async function visibleText(
  page: Page,
  selectors: readonly string[],
): Promise<string | null> {
  const locator = await firstVisibleLocator(page, selectors);
  if (locator === null) {
    return null;
  }
  const text = (await locator.innerText().catch(() => "")).trim();
  return text.length === 0 ? null : truncate(text);
}

async function captureMetadata(
  page: Page,
  observation: PageDiagnosticObservation,
  failure: BrowserAdapterFailure,
): Promise<Readonly<Record<string, unknown>>> {
  const assistantTurns = await firstPopulatedCollection(
    page,
    CHATGPT_SELECTORS.assistantTurns,
  );
  const assistantTurnCount = await assistantTurns.count().catch(() => 0);
  const targetTurn =
    assistantTurnCount === 0 ? null : assistantTurns.nth(assistantTurnCount - 1);
  const partialAssistantText =
    targetTurn === null
      ? null
      : truncate(await extractAssistantTurnText(targetTurn).catch(() => ""));
  const targetTurnHtml =
    targetTurn === null
      ? null
      : truncate(
          await targetTurn.evaluate((element) => element.outerHTML).catch(() => ""),
          MAX_DOM_FRAGMENT_LENGTH,
        );

  return {
    captured_at: new Date().toISOString(),
    failure,
    url: page.isClosed() ? null : page.url(),
    title: page.isClosed() ? null : await page.title().catch(() => null),
    visible_alert: page.isClosed()
      ? null
      : await visibleText(page, CHATGPT_SELECTORS.alert),
    visible_dialog: page.isClosed()
      ? null
      : await visibleText(page, CHATGPT_SELECTORS.confirmationDialog),
    partial_assistant_text:
      partialAssistantText === null || partialAssistantText.length === 0
        ? null
        : partialAssistantText,
    target_turn_html:
      targetTurnHtml === null || targetTurnHtml.length === 0
        ? null
        : targetTurnHtml,
    matched_selectors: page.isClosed()
      ? []
      : await CHATGPT_SELECTOR_REGISTRY.collectVisibleMatches(page),
    console_errors: [...observation.consoleErrors],
    failed_requests: [...observation.failedRequests],
  };
}

export interface FailureDiagnosticCaptureOptions {
  readonly includeScreenshot: boolean;
  readonly includeHtml: boolean;
  readonly includeTrace: boolean;
}

export async function captureFailureDiagnostics(
  page: Page,
  manager: BrowserManager,
  observation: PageDiagnosticObservation,
  failure: BrowserAdapterFailure,
  options: FailureDiagnosticCaptureOptions,
): Promise<readonly DiagnosticArtifactDraft[]> {
  const artifacts: DiagnosticArtifactDraft[] = [];

  if (!page.isClosed() && options.includeScreenshot) {
    const screenshot = await page
      .screenshot({ fullPage: true, type: "png" })
      .catch(() => null);
    if (screenshot !== null) {
      artifacts.push({
        type: "screenshot",
        mediaType: "image/png",
        suggestedExtension: "png",
        data: screenshot,
      });
    }
  }

  if (!page.isClosed() && options.includeHtml) {
    const html = await page.content().catch(() => null);
    if (html !== null) {
      artifacts.push(textArtifact("html", "text/html; charset=utf-8", "html", html));
    }
  }

  const metadata = await captureMetadata(page, observation, failure);
  artifacts.push(
    textArtifact(
      "dom_fragment",
      "application/json; charset=utf-8",
      "json",
      `${JSON.stringify(metadata, null, 2)}\n`,
    ),
  );

  if (options.includeTrace) {
    const trace = await manager.captureTraceChunk();
    if (trace !== null) {
      artifacts.push({
        type: "trace",
        mediaType: "application/zip",
        suggestedExtension: "zip",
        data: trace,
      });
    }
  }

  return artifacts;
}
