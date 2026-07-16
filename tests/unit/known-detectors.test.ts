import { describe, expect, it } from "vitest";

import {
  KNOWN_TRANSIENT_STATUS_PATTERNS,
  matchKnownAlert,
} from "../../src/browser/chatgpt/index.js";

describe("known ChatGPT detectors", () => {
  it("classifies curated alert text", () => {
    expect(matchKnownAlert("You have reached the current usage limit")).toMatchObject({
      name: "rate-limit",
      code: "rate_limited",
      retryable: true,
    });
    expect(matchKnownAlert("The tool call was aborted")).toMatchObject({
      name: "tool-failure",
      code: "tool_failed",
      retryable: false,
    });
    expect(matchKnownAlert("Something went wrong")).toMatchObject({
      name: "generation-failure",
      code: "send_failed",
      retryable: true,
    });
    expect(matchKnownAlert("Normal assistant text")).toBeNull();
  });

  it("keeps progress wording separate from errors", () => {
    expect(
      KNOWN_TRANSIENT_STATUS_PATTERNS.some((pattern) =>
        pattern.test("Searching the web"),
      ),
    ).toBe(true);
  });
});
