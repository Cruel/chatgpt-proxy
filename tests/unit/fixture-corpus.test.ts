import { describe, expect, it } from "vitest";

import {
  normalizeFixtureName,
  sanitizeDiagnosticHtml,
} from "../../src/diagnostics/fixture-corpus.js";

describe("diagnostic fixture corpus", () => {
  it("normalizes fixture names", () => {
    expect(normalizeFixtureName(" Changed Project Composer ")).toBe(
      "changed-project-composer",
    );
    expect(() => normalizeFixtureName("x")).toThrow(/3 to 80/);
  });

  it("removes active and identifying data from captured HTML", () => {
    const sanitized = sanitizeDiagnosticHtml(`
      <html><body>
        <script>window.secret = "token";</script>
        <a href="https://chatgpt.com/c/1234567890abcdef?model=test#frag">Open</a>
        <input value="private" data-token="secret">
        <p>person@example.com /home/alice/project g-p-1234567890abcdef</p>
      </body></html>
    `);

    expect(sanitized).not.toContain("window.secret");
    expect(sanitized).not.toContain("private");
    expect(sanitized).not.toContain("person@example.com");
    expect(sanitized).not.toContain("/home/alice");
    expect(sanitized).not.toContain("1234567890abcdef");
    expect(sanitized).toContain("[redacted-email]");
    expect(sanitized).toContain("/home/USER");
    expect(sanitized).toContain("g-p-REDACTED");
    expect(sanitized).not.toContain("model=test");
  });
});
