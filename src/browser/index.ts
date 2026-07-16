export type {
  BrowserAdapter,
  BrowserAdapterFailure,
  BrowserAdapterResult,
  BrowserOperationContext,
  BrowserStatusSnapshot,
  ConversationInspection,
  ConversationInspectionState,
  CreateConversationInput,
  DiagnosticArtifactDraft,
  DiagnosticArtifactType,
  DiagnosticCaptureInput,
  FinalAssistantResponse,
  RemoteConversationReference,
  RemoteDeletionOutcome,
  RemoteDeletionResult,
  SendMessageInput,
} from "./adapter.js";
export {
  FakeBrowserAdapter,
  type FakeBrowserAdapterOptions,
  type FakeConversation,
} from "./fake/index.js";
