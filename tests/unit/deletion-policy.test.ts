import { describe, expect, it } from "vitest";

import { decideDeletionPolicy } from "../../src/domain/index.js";

describe("deletion policy", () => {
  it.each([
    {
      configured: false,
      requested: false,
      expected: { kind: "local_only" },
    },
    {
      configured: true,
      requested: false,
      expected: { kind: "local_only" },
    },
    {
      configured: false,
      requested: true,
      expected: {
        kind: "rejected",
        errorCode: "remote_delete_disabled",
      },
    },
    {
      configured: true,
      requested: true,
      expected: { kind: "remote_allowed" },
    },
  ])(
    "returns $expected.kind when configured=$configured and requested=$requested",
    ({ configured, requested, expected }) => {
      expect(
        decideDeletionPolicy({
          remoteDeletionConfigured: configured,
          remoteDeletionRequested: requested,
        }),
      ).toEqual(expected);
    },
  );
});
