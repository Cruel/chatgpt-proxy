export {
  ChatGptBrowserAdapter,
  createChatGptBrowserAdapterFromConfig,
  type ChatGptBrowserAdapterOptions,
} from "./client.js";
export {
  captureSubmissionSnapshot,
  extractAssistantTurnText,
  waitForFinalAssistantResponse,
  type CompletionDetectorOptions,
  type CompletionResult,
  type SubmissionSnapshot,
} from "./completion-detector.js";
export { detectBlockingFailure } from "./error-detector.js";
export { deleteRemoteConversation } from "./deletion.js";
export {
  KNOWN_ALERT_DETECTORS,
  KNOWN_TRANSIENT_STATUS_PATTERNS,
  matchKnownAlert,
  type KnownTextDetector,
} from "./known-detectors.js";
export { submitMessage } from "./message-submission.js";
export {
  openExistingConversation,
  openProjectForNewConversation,
} from "./project-navigation.js";
export {
  CHATGPT_SELECTOR_REGISTRY,
  CHATGPT_SELECTORS,
  ChatGptSelectorRegistry,
  type ChatGptSelectorGroup,
  type MatchedSelector,
} from "./selectors.js";
export {
  conversationReferenceFromPage,
  extractConversationId,
  isConfiguredProjectUrl,
} from "./url.js";
