import { describe, expect, it, vi } from "vitest";

import {
  CliHttpError,
  HttpCliExecutor,
  parseDuration,
} from "../../src/cli/http-client.js";
import type { CliInvocation } from "../../src/cli/contracts.js";

function invocation(
  command: CliInvocation["command"],
): CliInvocation {
  return {
    command,
    options: {
      serverUrl: "http://127.0.0.1:7421",
      apiToken: "token",
      json: true,
      timeout: "5s",
    },
  };
}

describe("CLI HTTP client", () => {
  it("parses supported timeout units", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("2s")).toBe(2_000);
    expect(parseDuration("1.5m")).toBe(90_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(() => parseDuration("later")).toThrow(/Invalid timeout/);
  });

  it("generates an idempotency key and sends prompt JSON", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;
    const fetchImplementation: typeof fetch = (input, init) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      capturedOptions = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            run: {
              id: "00000000-0000-4000-8000-000000000001",
              state: "succeeded",
              finalResponse: "Done",
            },
            thread: { name: "review", state: "idle" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    };
    let output = "";
    const executor = new HttpCliExecutor({
      fetchImplementation,
      stdout: {
        write(text) {
          output += String(text);
          return true;
        },
      },
    });

    await executor.execute(
      invocation({
        kind: "new",
        name: "review",
        input: { kind: "message", value: "Review this." },
        wait: true,
        idempotencyKey: undefined,
      }),
    );

    expect(capturedUrl).toBe("http://127.0.0.1:7421/v1/threads");
    expect(capturedOptions?.method).toBe("POST");
    const headers = new Headers(capturedOptions?.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof capturedOptions?.body).toBe("string");
    expect(JSON.parse(capturedOptions?.body as string)).toEqual({
      name: "review",
      message: "Review this.",
      wait: true,
    });
    expect(JSON.parse(output)).toMatchObject({
      run: { state: "succeeded" },
    });
  });

  it("reads file input and preserves an explicit idempotency key", async () => {
    let capturedOptions: RequestInit | undefined;
    const executor = new HttpCliExecutor({
      readFileText: () => Promise.resolve("Prompt from file"),
      stdout: { write: () => true },
      fetchImplementation: (_input, init) => {
        capturedOptions = init;
        return Promise.resolve(
          new Response(JSON.stringify({ run: {}, thread: {} }), {
            status: 202,
          }),
        );
      },
    });

    await executor.execute(
      invocation({
        kind: "chat",
        name: "review",
        input: { kind: "file", value: "prompt.txt" },
        wait: false,
        idempotencyKey: "fixed-key",
      }),
    );

    const headers = new Headers(capturedOptions?.headers);
    expect(headers.get("idempotency-key")).toBe("fixed-key");
    expect(typeof capturedOptions?.body).toBe("string");
    expect(JSON.parse(capturedOptions?.body as string)).toEqual({
      message: "Prompt from file",
      wait: false,
    });
  });

  it("requires confirmation before remote deletion", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const executor = new HttpCliExecutor({
      fetchImplementation,
      confirmRemoteDeletion: () => Promise.resolve(false),
    });

    await expect(
      executor.execute(
        invocation({
          kind: "delete",
          name: "review",
          remote: true,
          yes: false,
          wait: true,
          idempotencyKey: undefined,
        }),
      ),
    ).rejects.toThrow(/cancelled/);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("preserves structured server errors for JSON output", () => {
    const error = new CliHttpError(
      "Remote deletion is disabled",
      409,
      "remote_delete_disabled",
      {
        error: {
          code: "remote_delete_disabled",
          message: "Remote deletion is disabled",
        },
      },
      true,
    );

    expect(JSON.parse(error.formatForStderr())).toEqual({
      error: {
        code: "remote_delete_disabled",
        message: "Remote deletion is disabled",
      },
    });
  });
});
