import { describe, expect, it } from "vitest";

import {
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  listThreadsQuerySchema,
} from "../../src/api/index.js";

describe("API schemas", () => {
  it("defaults synchronous create requests to wait", () => {
    expect(
      createThreadRequestSchema.parse({
        name: "renderer-review",
        message: "Review the renderer.",
      }),
    ).toEqual({
      name: "renderer-review",
      message: "Review the renderer.",
      wait: true,
    });
  });

  it("defaults deletion to local-only", () => {
    expect(deleteThreadRequestSchema.parse(undefined)).toEqual({
      delete_remote: false,
      wait: true,
    });
  });

  it("parses include_deleted query strings without treating arbitrary text as true", () => {
    expect(listThreadsQuerySchema.parse({ include_deleted: "true" })).toEqual({
      include_deleted: true,
    });
    expect(listThreadsQuerySchema.parse({ include_deleted: "false" })).toEqual({
      include_deleted: false,
    });
    expect(() =>
      listThreadsQuerySchema.parse({ include_deleted: "yes" }),
    ).toThrow();
  });
});
