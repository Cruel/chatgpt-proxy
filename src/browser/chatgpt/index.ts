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
export { submitMessage } from "./message-submission.js";
export {
  openExistingConversation,
  openProjectForNewConversation,
} from "./project-navigation.js";
export { CHATGPT_SELECTORS } from "./selectors.js";
export {
  conversationReferenceFromPage,
  extractConversationId,
  isConfiguredProjectUrl,
} from "./url.js";
