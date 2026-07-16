import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/logging/index.js";

describe("structured logger", () => {
  it("redacts configured credentials", () => {
    let output = "";
    const destination = new Writable({
      write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        output += chunk.toString("utf8");
        callback();
      },
    });
    const logger = createLogger({ destination });

    logger.info(
      {
        apiToken: "top-secret-token",
        req: {
          headers: {
            authorization: "Bearer top-secret-token",
            cookie: "session=top-secret-cookie",
          },
        },
      },
      "request received",
    );

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("top-secret-token");
    expect(output).not.toContain("top-secret-cookie");
  });
});
