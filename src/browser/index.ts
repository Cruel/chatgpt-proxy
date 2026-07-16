export type {
  BrowserAdapter,
  BrowserAdapterFailure,
  BrowserAdapterResult,
  BrowserOperationGate,
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
  BrowserLifecycleError,
  BrowserOperationBlockedError,
  PageLeaseAbortedError,
  PagePoolClosedError,
} from "./errors.js";
export {
  BrowserManager,
  createBrowserManagerFromConfig,
  type BrowserManagerOptions,
  type PersistentContextLauncher,
  type WaitForBrowserReadyOptions,
} from "./manager.js";
export {
  PagePool,
  type PageLease,
  type PageLeaseReleaseOptions,
  type PagePoolOptions,
} from "./page-pool.js";
export {
  ChatGptAuthenticationProbe,
  type BrowserStatusObservation,
  type BrowserStatusProbe,
  type ObservableBrowserStatus,
} from "./status-probe.js";
export {
  FakeBrowserAdapter,
  type FakeBrowserAdapterOptions,
  type FakeConversation,
} from "./fake/index.js";
