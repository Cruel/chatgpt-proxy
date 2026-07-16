import { describe, expect, it } from "vitest";

import { normalizeThreadName } from "../../src/domain/index.js";

describe("thread-name normalization", () => {
  it("normalizes Unicode, case, outer whitespace, and repeated whitespace", () => {
    expect(normalizeThreadName("  Renderer\tReview  ")).toBe("renderer review");
    expect(normalizeThreadName("ＲＥＮＤＥＲＥＲ")).toBe("renderer");
  });
});
