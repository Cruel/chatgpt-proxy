import type {
  ApiErrorCode,
  BrowserStatus,
  ThinkingLevel,
} from "../domain/states.js";

export interface BrowserOperationContext {
  readonly runId: string;
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly onConversationIdentified?: (
    conversation: RemoteConversationReference,
  ) => void;
}

export interface BrowserStatusSnapshot {
  readonly status: BrowserStatus;
  readonly detail: string | null;
  readonly activePageCount: number;
  readonly queuedRunCount: number;
  readonly observedAt: string;
}

export interface BrowserOperationGate {
  canDispatch(): boolean;
  onChange(listener: () => void): () => void;
}

export interface RemoteConversationReference {
  readonly conversationId: string;
  readonly url: string;
  readonly title: string | null;
}

export interface FinalAssistantResponse {
  readonly text: string;
  readonly conversation: RemoteConversationReference;
}

export interface CreateConversationInput {
  readonly projectUrl: string;
  readonly message: string;
  readonly thinking?: ThinkingLevel;
}

export interface SendMessageInput {
  readonly conversation: RemoteConversationReference;
  readonly message: string;
  readonly thinking?: ThinkingLevel;
}

export type ConversationInspectionState =
  | "ready"
  | "auth_required"
  | "verification_required"
  | "missing"
  | "generating"
  | "needs_confirmation"
  | "error";

export interface ConversationInspection {
  readonly state: ConversationInspectionState;
  readonly conversation: RemoteConversationReference | null;
  readonly inputAvailable: boolean;
  readonly partialAssistantText: string | null;
  readonly detail: string | null;
}

export type RemoteDeletionOutcome =
  | "deleted"
  | "already_absent"
  | "ambiguous";

export interface RemoteDeletionResult {
  readonly outcome: RemoteDeletionOutcome;
  readonly evidence: readonly string[];
}

export interface BrowserAdapterFailure {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly observedUrl: string | null;
}

export type BrowserAdapterResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BrowserAdapterFailure };

export type DiagnosticArtifactType =
  | "screenshot"
  | "html"
  | "trace"
  | "dom_fragment";

export interface DiagnosticArtifactDraft {
  readonly type: DiagnosticArtifactType;
  readonly mediaType: string;
  readonly suggestedExtension: string;
  readonly data: Uint8Array;
}

export interface DiagnosticCaptureInput {
  readonly runId: string;
  readonly phase: string;
  readonly includeScreenshot: boolean;
  readonly includeHtml: boolean;
  readonly includeTrace: boolean;
}

/**
 * Boundary between durable service orchestration and ChatGPT-specific browser
 * automation. Implementations must not persist runs or mutate scheduler state.
 */
export interface BrowserAdapter {
  readonly operationGate?: BrowserOperationGate;

  start?(): Promise<BrowserStatusSnapshot>;

  getStatus(): Promise<BrowserStatusSnapshot>;

  createConversation(
    input: CreateConversationInput,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<FinalAssistantResponse>>;

  sendMessage(
    input: SendMessageInput,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<FinalAssistantResponse>>;

  inspectConversation(
    conversation: RemoteConversationReference,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<ConversationInspection>>;

  deleteConversation(
    conversation: RemoteConversationReference,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<RemoteDeletionResult>>;

  captureDiagnostics(
    input: DiagnosticCaptureInput,
    context: BrowserOperationContext,
  ): Promise<BrowserAdapterResult<readonly DiagnosticArtifactDraft[]>>;

  close?(): Promise<void>;
}
