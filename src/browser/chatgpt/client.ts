import type { Locator, Page } from "playwright";
import type { Logger } from "pino";

import type { AppConfig } from "../../config/schema.js";
import type {
  BrowserAdapter,
  BrowserAdapterFailure,
  BrowserAdapterResult,
  BrowserOperationContext,
  BrowserOperationGate,
  BrowserStatusSnapshot,
  ConversationInspection,
  CreateConversationInput,
  DiagnosticArtifactDraft,
  DiagnosticCaptureInput,
  FinalAssistantResponse,
  RemoteConversationReference,
  RemoteDeletionResult,
  SendMessageInput,
} from "../adapter.js";
import {
  BrowserLifecycleError,
  BrowserOperationBlockedError,
  PageLeaseAbortedError,
  PagePoolClosedError,
} from "../errors.js";
import {
  createBrowserManagerFromConfig,
} from "../manager.js";
import type { BrowserManager } from "../manager.js";
import type { PageLease } from "../page-pool.js";
import {
  extractAssistantTurnText,
  waitForFinalAssistantResponse,
} from "./completion-detector.js";
import { detectBlockingFailure } from "./error-detector.js";
import { submitMessage } from "./message-submission.js";
import {
  openExistingConversation,
  openProjectForNewConversation,
} from "./project-navigation.js";
import {
  CHATGPT_SELECTORS,
  anyVisible,
  firstPopulatedCollection,
} from "./selectors.js";

export interface ChatGptBrowserAdapterOptions {
  readonly manager: BrowserManager;
  readonly navigationTimeoutMs: number;
  readonly responseTimeoutMs: number;
  readonly submissionTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stableContentMs?: number;
}

function blockedFailure(error: unknown): BrowserAdapterFailure {
  if (error instanceof BrowserOperationBlockedError) {
    const code =
      error.status === "auth_required"
        ? "auth_required"
        : error.status === "verification_required"
          ? "verification_required"
          : error.status === "recovering" || error.status === "starting"
            ? "browser_crashed"
            : "unexpected_state";
    return {
      code,
      message: error.message,
      retryable: true,
      observedUrl: null,
    };
  }
  if (
    error instanceof PageLeaseAbortedError ||
    error instanceof PagePoolClosedError ||
    error instanceof BrowserLifecycleError
  ) {
    return {
      code: "browser_crashed",
      message: error.message,
      retryable: true,
      observedUrl: null,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "unexpected_state",
    message,
    retryable: false,
    observedUrl: null,
  };
}

function shouldDiscardPage(failure: BrowserAdapterFailure): boolean {
  return [
    "auth_required",
    "verification_required",
    "browser_crashed",
    "navigation_failed",
  ].includes(failure.code);
}

async function lastAssistantTurn(page: Page): Promise<Locator | null> {
  const turns = await firstPopulatedCollection(page, CHATGPT_SELECTORS.assistantTurns);
  const count = await turns.count();
  return count === 0 ? null : turns.nth(count - 1);
}

export class ChatGptBrowserAdapter implements BrowserAdapter {
  public readonly operationGate: BrowserOperationGate;

  private readonly manager: BrowserManager;
  private readonly navigationTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly submissionTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stableContentMs: number;

  public constructor(options: ChatGptBrowserAdapterOptions) {
    this.manager = options.manager;
    this.operationGate = options.manager.operationGate;
    this.navigationTimeoutMs = options.navigationTimeoutMs;
    this.responseTimeoutMs = options.responseTimeoutMs;
    this.submissionTimeoutMs =
      options.submissionTimeoutMs ?? options.navigationTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.stableContentMs = options.stableContentMs ?? 1_250;
  }

  public start(): Promise<BrowserStatusSnapshot> {
    return this.manager.start();
  }

  public getStatus(): Promise<BrowserStatusSnapshot> {
    return this.manager.refreshStatus();
  }

  public waitForReady(options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<BrowserStatusSnapshot> {
    return this.manager.waitForReady(options);
  }

  public createConversation(
    input: CreateConversationInput,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<FinalAssistantResponse>> {
    return this.withLease<FinalAssistantResponse>(context, async (page) => {
      const navigationFailure = await openProjectForNewConversation(
        page,
        this.manager,
        {
          projectUrl: input.projectUrl,
          navigationTimeoutMs: this.navigationTimeoutMs,
        },
      );
      if (navigationFailure !== null) {
        return { ok: false, error: navigationFailure };
      }

      const submission = await submitMessage(
        page,
        this.manager,
        input.message,
        context,
        {
          submissionTimeoutMs: this.submissionTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
        },
      );
      if (!submission.ok) {
        return submission;
      }

      const completion = await waitForFinalAssistantResponse(
        page,
        this.manager,
        submission.snapshot,
        submission.conversation,
        {
          responseTimeoutMs: this.responseTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
          stableContentMs: this.stableContentMs,
          ...(context.onConversationIdentified === undefined
            ? {}
            : {
                onConversationIdentified: context.onConversationIdentified,
              }),
        },
      );
      if (!completion.ok) {
        return completion;
      }
      return { ok: true, value: completion.response };
    });
  }

  public sendMessage(
    input: SendMessageInput,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<FinalAssistantResponse>> {
    return this.withLease<FinalAssistantResponse>(context, async (page) => {
      const navigationFailure = await openExistingConversation(
        page,
        this.manager,
        {
          url: input.conversation.url,
          conversationId: input.conversation.conversationId,
          navigationTimeoutMs: this.navigationTimeoutMs,
        },
      );
      if (navigationFailure !== null) {
        return { ok: false, error: navigationFailure };
      }

      const submission = await submitMessage(
        page,
        this.manager,
        input.message,
        context,
        {
          submissionTimeoutMs: this.submissionTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
        },
      );
      if (!submission.ok) {
        return submission;
      }

      const completion = await waitForFinalAssistantResponse(
        page,
        this.manager,
        submission.snapshot,
        input.conversation,
        {
          responseTimeoutMs: this.responseTimeoutMs,
          pollIntervalMs: this.pollIntervalMs,
          stableContentMs: this.stableContentMs,
        },
      );
      return completion.ok
        ? { ok: true, value: completion.response }
        : completion;
    });
  }

  public inspectConversation(
    conversation: RemoteConversationReference,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<ConversationInspection>> {
    return this.withLease<ConversationInspection>(context, async (page) => {
      const navigationFailure = await openExistingConversation(
        page,
        this.manager,
        {
          url: conversation.url,
          conversationId: conversation.conversationId,
          navigationTimeoutMs: this.navigationTimeoutMs,
        },
      );
      if (navigationFailure !== null) {
        if (navigationFailure.code === "thread_not_found") {
          return {
            ok: true,
            value: {
              state: "missing",
              conversation: null,
              inputAvailable: false,
              partialAssistantText: null,
              detail: navigationFailure.message,
            },
          };
        }
        if (
          navigationFailure.code === "auth_required" ||
          navigationFailure.code === "verification_required"
        ) {
          return {
            ok: true,
            value: {
              state: navigationFailure.code,
              conversation,
              inputAvailable: false,
              partialAssistantText: null,
              detail: navigationFailure.message,
            },
          };
        }
        return { ok: false, error: navigationFailure };
      }

      const blockingFailure = await detectBlockingFailure(page, this.manager);
      if (blockingFailure?.code === "needs_confirmation") {
        return {
          ok: true,
          value: {
            state: "needs_confirmation",
            conversation,
            inputAvailable: false,
            partialAssistantText: null,
            detail: blockingFailure.message,
          },
        };
      }
      if (blockingFailure !== null) {
        return { ok: false, error: blockingFailure };
      }

      const turn = await lastAssistantTurn(page);
      const partial = turn === null ? "" : await extractAssistantTurnText(turn);
      const generating = await anyVisible(
        page,
        CHATGPT_SELECTORS.generationControl,
      );
      return {
        ok: true,
        value: {
          state: generating ? "generating" : "ready",
          conversation,
          inputAvailable: await anyVisible(page, CHATGPT_SELECTORS.composer),
          partialAssistantText: partial.length === 0 ? null : partial,
          detail: null,
        },
      };
    });
  }

  public deleteConversation(
    conversation: RemoteConversationReference,
  ): Promise<BrowserAdapterResult<RemoteDeletionResult>> {
    return Promise.resolve({
      ok: false,
      error: {
        code: "remote_delete_failed",
        message:
          "Remote ChatGPT conversation deletion is not implemented until Phase 7",
        retryable: false,
        observedUrl: conversation.url,
      },
    });
  }

  public captureDiagnostics(
    input: DiagnosticCaptureInput,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<readonly DiagnosticArtifactDraft[]>> {
    void input;
    void context;
    return Promise.resolve({ ok: true, value: [] });
  }

  public close(): Promise<void> {
    return this.manager.close();
  }

  private async withLease<T>(
    context: BrowserOperationContext,
    operation: (page: Page) => Promise<BrowserAdapterResult<T>>,
  ): Promise<BrowserAdapterResult<T>> {
    let lease: PageLease | null = null;
    let discard = false;
    try {
      lease = await this.manager.leasePage(context.signal);
      const result = await operation(lease.page);
      discard = !result.ok && shouldDiscardPage(result.error);
      return result;
    } catch (error) {
      const failure = blockedFailure(error);
      discard = shouldDiscardPage(failure);
      return { ok: false, error: failure };
    } finally {
      await lease?.release({ discard }).catch(() => undefined);
    }
  }
}

export function createChatGptBrowserAdapterFromConfig(
  config: AppConfig,
  logger?: Pick<Logger, "debug" | "error" | "info" | "warn">,
): ChatGptBrowserAdapter {
  const manager = createBrowserManagerFromConfig(config, logger);
  return new ChatGptBrowserAdapter({
    manager,
    navigationTimeoutMs: config.browser.navigationTimeoutSeconds * 1_000,
    responseTimeoutMs: config.browser.responseTimeoutSeconds * 1_000,
  });
}
