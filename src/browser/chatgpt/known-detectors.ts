import type { ApiErrorCode } from "../../domain/states.js";

export interface KnownTextDetector {
  readonly name: string;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly patterns: readonly RegExp[];
}

export const KNOWN_ALERT_DETECTORS: readonly KnownTextDetector[] = [
  {
    name: "rate-limit",
    code: "rate_limited",
    retryable: true,
    patterns: [
      /usage limit/i,
      /rate limit/i,
      /too many requests/i,
      /try again later/i,
      /reached the current limit/i,
    ],
  },
  {
    name: "tool-failure",
    code: "tool_failed",
    retryable: false,
    patterns: [
      /tool execution failed/i,
      /tool failed/i,
      /error using tool/i,
      /tool call (?:was )?aborted/i,
      /research (?:was )?stopped/i,
    ],
  },
  {
    name: "generation-failure",
    code: "send_failed",
    retryable: true,
    patterns: [
      /something went wrong/i,
      /network error/i,
      /error generating/i,
      /failed to get upload status/i,
      /unable to load/i,
    ],
  },
] as const;

export const KNOWN_TRANSIENT_STATUS_PATTERNS = [
  /searching(?: the web)?/i,
  /reading/i,
  /analyzing/i,
  /thinking/i,
  /working/i,
  /generating/i,
] as const;

export function matchKnownAlert(text: string): KnownTextDetector | null {
  return (
    KNOWN_ALERT_DETECTORS.find((detector) =>
      detector.patterns.some((pattern) => pattern.test(text)),
    ) ?? null
  );
}
