import { describe, expect, it } from "vitest";

import {
  extractConversationId,
  isConfiguredProjectUrl,
} from "../../src/browser/index.js";

describe("ChatGPT URL handling", () => {
  it("extracts conversation IDs from standard and project-scoped URLs", () => {
    expect(
      extractConversationId("https://chatgpt.com/c/12345678-abcd-efgh"),
    ).toBe("12345678-abcd-efgh");
    expect(
      extractConversationId(
        "https://chatgpt.com/g/g-p-example/c/project-conversation-1",
      ),
    ).toBe("project-conversation-1");
    expect(
      extractConversationId(
        "https://chatgpt.com/?conversation_id=query-conversation-1",
      ),
    ).toBe("query-conversation-1");
    expect(extractConversationId("https://chatgpt.com/")).toBeNull();
  });

  it("uses a project fingerprint when the configured URL exposes one", () => {
    const configured =
      "https://chatgpt.com/g/g-p-example-project/project";
    expect(
      isConfiguredProjectUrl(
        "https://chatgpt.com/g/g-p-example-project",
        configured,
      ),
    ).toBe(true);
    expect(
      isConfiguredProjectUrl(
        "https://chatgpt.com/g/g-p-other-project",
        configured,
      ),
    ).toBe(false);
  });

  it("requires the configured path when no project fingerprint is present", () => {
    expect(
      isConfiguredProjectUrl(
        "http://127.0.0.1:1234/project/example/new",
        "http://127.0.0.1:1234/project/example",
      ),
    ).toBe(true);
    expect(
      isConfiguredProjectUrl(
        "http://127.0.0.1:1234/project/other",
        "http://127.0.0.1:1234/project/example",
      ),
    ).toBe(false);
  });
});
