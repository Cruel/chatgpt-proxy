import { randomUUID } from "node:crypto";

import type {
  BrowserAdapter,
  BrowserAdapterResult,
  BrowserStatusSnapshot,
  ConversationInspection,
  CreateConversationInput,
  DiagnosticArtifactDraft,
  FinalAssistantResponse,
  RemoteConversationReference,
  RemoteDeletionResult,
  SendMessageInput,
} from "../adapter.js";

export interface FakeConversation {
  readonly conversation: RemoteConversationReference;
  readonly messages: readonly string[];
}

export interface FakeBrowserAdapterOptions {
  readonly responsePrefix?: string;
  readonly status?: BrowserStatusSnapshot["status"];
  readonly detail?: string | null;
}

type CreateResult = BrowserAdapterResult<FinalAssistantResponse>;
type SendResult = BrowserAdapterResult<FinalAssistantResponse>;
type DeleteResult = BrowserAdapterResult<RemoteDeletionResult>;

interface MutableConversation {
  conversation: RemoteConversationReference;
  messages: string[];
}

export class FakeBrowserAdapter implements BrowserAdapter {
  public readonly createCalls: CreateConversationInput[] = [];
  public readonly sendCalls: SendMessageInput[] = [];
  public readonly deleteCalls: RemoteConversationReference[] = [];
  public readonly inspectCalls: RemoteConversationReference[] = [];

  private readonly responsePrefix: string;
  private readonly conversations = new Map<string, MutableConversation>();
  private readonly createResults: CreateResult[] = [];
  private readonly sendResults: SendResult[] = [];
  private readonly deleteResults: DeleteResult[] = [];
  private status: BrowserStatusSnapshot["status"];
  private detail: string | null;

  public constructor(options: FakeBrowserAdapterOptions = {}) {
    this.responsePrefix = options.responsePrefix ?? "Fake response";
    this.status = options.status ?? "ready";
    this.detail = options.detail ?? null;
  }

  public setStatus(
    status: BrowserStatusSnapshot["status"],
    detail: string | null = null,
  ): void {
    this.status = status;
    this.detail = detail;
  }

  public enqueueCreateResult(result: CreateResult): void {
    this.createResults.push(result);
  }

  public enqueueSendResult(result: SendResult): void {
    this.sendResults.push(result);
  }

  public enqueueDeleteResult(result: DeleteResult): void {
    this.deleteResults.push(result);
  }

  public listConversations(): readonly FakeConversation[] {
    return [...this.conversations.values()].map((entry) => ({
      conversation: entry.conversation,
      messages: [...entry.messages],
    }));
  }

  public getStatus(): Promise<BrowserStatusSnapshot> {
    return Promise.resolve({
      status: this.status,
      detail: this.detail,
      activePageCount: 0,
      queuedRunCount: 0,
      observedAt: new Date().toISOString(),
    });
  }

  public createConversation(
    input: CreateConversationInput,
  ): Promise<CreateResult> {
    this.createCalls.push(input);
    const scripted = this.createResults.shift();
    if (scripted !== undefined) {
      if (scripted.ok) {
        this.remember(scripted.value.conversation, input.message);
      }
      return Promise.resolve(scripted);
    }

    const conversationId = randomUUID();
    const conversation: RemoteConversationReference = {
      conversationId,
      url: `https://chatgpt.com/c/${conversationId}`,
      title: null,
    };
    this.remember(conversation, input.message);
    return Promise.resolve({
      ok: true,
      value: {
        text: `${this.responsePrefix}: ${input.message}`,
        conversation,
      },
    });
  }

  public sendMessage(
    input: SendMessageInput,
  ): Promise<SendResult> {
    this.sendCalls.push(input);
    const scripted = this.sendResults.shift();
    if (scripted !== undefined) {
      if (scripted.ok) {
        this.remember(scripted.value.conversation, input.message);
      }
      return Promise.resolve(scripted);
    }

    const existing = this.conversations.get(input.conversation.conversationId);
    if (existing === undefined) {
      return Promise.resolve({
        ok: false,
        error: {
          code: "thread_not_found",
          message: "The fake remote conversation does not exist",
          retryable: false,
          observedUrl: input.conversation.url,
        },
      });
    }
    existing.messages.push(input.message);
    return Promise.resolve({
      ok: true,
      value: {
        text: `${this.responsePrefix}: ${input.message}`,
        conversation: existing.conversation,
      },
    });
  }

  public inspectConversation(
    conversation: RemoteConversationReference,
  ): Promise<BrowserAdapterResult<ConversationInspection>> {
    this.inspectCalls.push(conversation);
    const existing = this.conversations.get(conversation.conversationId);
    return Promise.resolve({
      ok: true,
      value: existing === undefined
        ? {
            state: "missing",
            conversation: null,
            inputAvailable: false,
            partialAssistantText: null,
            detail: "Conversation is absent from the fake adapter",
          }
        : {
            state: "ready",
            conversation: existing.conversation,
            inputAvailable: true,
            partialAssistantText: null,
            detail: null,
          },
    });
  }

  public deleteConversation(
    conversation: RemoteConversationReference,
  ): Promise<DeleteResult> {
    this.deleteCalls.push(conversation);
    const scripted = this.deleteResults.shift();
    if (scripted !== undefined) {
      if (
        scripted.ok &&
        ["deleted", "already_absent"].includes(scripted.value.outcome)
      ) {
        this.conversations.delete(conversation.conversationId);
      }
      return Promise.resolve(scripted);
    }

    const existed = this.conversations.delete(conversation.conversationId);
    return Promise.resolve({
      ok: true,
      value: {
        outcome: existed ? "deleted" : "already_absent",
        evidence: [existed ? "fake conversation removed" : "fake conversation absent"],
      },
    });
  }

  public captureDiagnostics(): Promise<
    BrowserAdapterResult<readonly DiagnosticArtifactDraft[]>
  > {
    return Promise.resolve({ ok: true, value: [] });
  }

  private remember(
    conversation: RemoteConversationReference,
    message: string,
  ): void {
    const existing = this.conversations.get(conversation.conversationId);
    if (existing === undefined) {
      this.conversations.set(conversation.conversationId, {
        conversation,
        messages: [message],
      });
      return;
    }
    existing.conversation = conversation;
    existing.messages.push(message);
  }
}
