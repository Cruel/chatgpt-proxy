import { describe, expect, it } from "vitest";

import {
  createThreadRequestSchema,
  deleteThreadRequestSchema,
  doctorResponseSchema,
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

  it("validates operational doctor reports", () => {
    expect(
      doctorResponseSchema.parse({
        status: "warning",
        version: "0.1.0",
        observedAt: "2026-07-16T18:00:00.000Z",
        checks: [
          {
            id: "browser",
            status: "warning",
            summary: "ChatGPT login is required",
            detail: "Login expired",
            remediation: "Complete login in the headed browser.",
          },
        ],
        browser: {
          status: "auth_required",
          detail: "Login expired",
          activePageCount: 0,
          queuedRunCount: 2,
          observedAt: "2026-07-16T18:00:00.000Z",
        },
        queue: {
          state: "running",
          activeRunCount: 0,
          queuedRunCount: 2,
          dispatchEnabled: false,
        },
      }).status,
    ).toBe("warning");
  });
});
