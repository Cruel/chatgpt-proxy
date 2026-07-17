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
  it("renders thread info with the latest final response or error", async () => {
    const outputs: string[] = [];
    const payloads = [
      {
        thread: {
          name: "completed",
          state: "idle",
          lastErrorMessage: null,
        },
        pendingRun: null,
        history: [
          {
            finalResponse: "Completed response body",
          },
        ],
      },
      {
        thread: {
          name: "failed",
          state: "needs_attention",
          lastErrorMessage: "Recovery could not verify the remote prompt",
        },
        pendingRun: null,
        history: [],
      },
    ];
    let responseIndex = 0;
    const executor = new HttpCliExecutor({
      fetchImplementation: () =>
        Promise.resolve(
          new Response(JSON.stringify(payloads[responseIndex++]), {
            status: 200,
          }),
        ),
      stdout: {
        write(text) {
          outputs.push(String(text));
          return true;
        },
      },
    });

    for (const name of ["completed", "failed"]) {
      await executor.execute({
        command: { kind: "info", name },
        options: {
          serverUrl: "http://127.0.0.1:7421",
          apiToken: undefined,
          json: false,
          timeout: "5s",
        },
      });
    }

    expect(outputs.join("")).toContain(
      "completed: idle\nCompleted response body\n",
    );
    expect(outputs.join("")).toContain(
      "failed: needs_attention\nError: Recovery could not verify the remote prompt\n",
    );
  });

  it("renders doctor checks with actionable remediation", async () => {
    let capturedUrl = "";
    let output = "";
    const executor = new HttpCliExecutor({
      fetchImplementation: (input) => {
        capturedUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "warning",
              version: "0.1.0",
              observedAt: "2026-07-16T18:00:00.000Z",
              checks: [
                {
                  id: "browser",
                  status: "warning",
                  summary: "ChatGPT login is required",
                  detail: "Login expired",
                  remediation: "Complete login in the headed browser window.",
                },
              ],
              browser: {},
              queue: {},
            }),
            { status: 200 },
          ),
        );
      },
      stdout: {
        write(text) {
          output += String(text);
          return true;
        },
      },
    });

    await executor.execute({
      command: { kind: "doctor" },
      options: {
        serverUrl: "http://127.0.0.1:7421",
        apiToken: "token",
        json: false,
        timeout: "5s",
      },
    });

    expect(capturedUrl).toBe("http://127.0.0.1:7421/v1/doctor");
    expect(output).toContain("Operational status: warning");
    expect(output).toContain("[WARNING] ChatGPT login is required");
    expect(output).toContain("Action: Complete login");
  });

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
      wait: false,
    });
    expect(JSON.parse(output)).toMatchObject({
      run: { state: "succeeded" },
    });
  });

  it("submits new tasks asynchronously and polls the returned run by default", async () => {
    const urls: string[] = [];
    const responses = [
      {
        run: {
          id: "00000000-0000-4000-8000-000000000111",
          state: "queued",
          finalResponse: null,
        },
        thread: { name: "review", state: "running" },
      },
      {
        run: {
          id: "00000000-0000-4000-8000-000000000111",
          state: "running",
          finalResponse: null,
        },
      },
      {
        run: {
          id: "00000000-0000-4000-8000-000000000111",
          state: "succeeded",
          finalResponse: "Finished",
        },
      },
    ];
    let calls = 0;
    let output = "";
    const executor = new HttpCliExecutor({
      runPollIntervalMs: 1,
      stdout: {
        write(text) {
          output += String(text);
          return true;
        },
      },
      fetchImplementation: (input) => {
        urls.push(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        );
        const payload = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      },
    });

    await executor.execute({
      command: {
        kind: "new",
        name: "review",
        input: { kind: "message", value: "Do the work." },
        wait: true,
        idempotencyKey: undefined,
      },
      options: {
        serverUrl: "http://127.0.0.1:7421",
        apiToken: undefined,
        json: false,
        timeout: "1s",
      },
    });

    expect(urls).toEqual([
      "http://127.0.0.1:7421/v1/threads",
      "http://127.0.0.1:7421/v1/runs/00000000-0000-4000-8000-000000000111",
      "http://127.0.0.1:7421/v1/runs/00000000-0000-4000-8000-000000000111",
    ]);
    expect(output).toContain("Run 00000000-0000-4000-8000-000000000111: succeeded");
    expect(output).toContain("Finished");
  });

  it("can call a tokenless local server without an authorization header", async () => {
    let capturedHeaders: Headers | undefined;
    const executor = new HttpCliExecutor({
      stdout: { write: () => true },
      fetchImplementation: (_input, init) => {
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(
          new Response(JSON.stringify({ threads: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    await executor.execute({
      command: { kind: "threads", includeDeleted: false },
      options: {
        serverUrl: "http://127.0.0.1:7421",
        apiToken: undefined,
        json: true,
        timeout: "5s",
      },
    });

    expect(capturedHeaders?.has("authorization")).toBe(false);
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

  it("allows an explicit --yes remote deletion without prompting", async () => {
    const confirmRemoteDeletion = vi.fn(() => Promise.resolve(false));
    let capturedBody: unknown;
    const executor = new HttpCliExecutor({
      confirmRemoteDeletion,
      stdout: { write: () => true },
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(
          new Response(JSON.stringify({ run: {}, thread: {} }), {
            status: 200,
          }),
        );
      },
    });

    await executor.execute(
      invocation({
        kind: "delete",
        name: "review",
        remote: true,
        yes: true,
        wait: true,
        idempotencyKey: "delete-review",
      }),
    );

    expect(confirmRemoteDeletion).not.toHaveBeenCalled();
    expect(capturedBody).toEqual({ delete_remote: true, wait: true });
  });

  it("waits on an existing run until its stored result is terminal", async () => {
    const responses = [
      { run: { id: "run-1", state: "submitting", finalResponse: null } },
      { run: { id: "run-1", state: "running", finalResponse: null } },
      { run: { id: "run-1", state: "succeeded", finalResponse: "Finished" } },
    ];
    let calls = 0;
    let output = "";
    const executor = new HttpCliExecutor({
      runPollIntervalMs: 1,
      stdout: {
        write(text) {
          output += String(text);
          return true;
        },
      },
      fetchImplementation: () => {
        const payload = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      },
    });

    await executor.execute({
      command: { kind: "run", runId: "run-1", wait: true },
      options: {
        serverUrl: "http://127.0.0.1:7421",
        apiToken: undefined,
        json: false,
        timeout: "1s",
      },
    });

    expect(calls).toBe(3);
    expect(output).toContain("Run run-1: succeeded");
    expect(output).toContain("Finished");
  });

  it("reports client timeouts separately from connection failures", async () => {
    const timeout = new DOMException("The operation was aborted", "TimeoutError");
    const executor = new HttpCliExecutor({
      fetchImplementation: () => Promise.reject(new TypeError("fetch failed", { cause: timeout })),
    });

    const error = await executor.execute({
        command: { kind: "run", runId: "run-1", wait: false },
        options: {
          serverUrl: "http://127.0.0.1:7421",
          apiToken: undefined,
          json: false,
          timeout: "5s",
        },
      }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CliHttpError);
    if (!(error instanceof CliHttpError)) {
      throw new Error("Expected CliHttpError");
    }
    expect(error.code).toBe("client_timeout");
    expect(error.message).toContain("Request timed out");
    expect(error.message).toContain("pnpm cli run run-1 --wait");
  });

  it("recovers a pending run id after a mutation request times out", async () => {
    const timeout = new DOMException("The operation was aborted", "TimeoutError");
    let calls = 0;
    const executor = new HttpCliExecutor({
      fetchImplementation: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new TypeError("fetch failed", { cause: timeout }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              pendingRun: {
                id: "5a486fc9-480a-4ccd-9017-10840e71f0ef",
                state: "submitting",
              },
            }),
            { status: 200 },
          ),
        );
      },
    });

    const error = await executor
      .execute({
        command: {
          kind: "chat",
          name: "review",
          input: { kind: "message", value: "Continue." },
          wait: true,
          idempotencyKey: undefined,
        },
        options: {
          serverUrl: "http://127.0.0.1:7421",
          apiToken: undefined,
          json: false,
          timeout: "5s",
        },
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CliHttpError);
    if (!(error instanceof CliHttpError)) {
      throw new Error("Expected CliHttpError");
    }
    expect(calls).toBe(2);
    expect(error.message).toContain("5a486fc9-480a-4ccd-9017-10840e71f0ef");
    expect(error.message).toContain(
      "pnpm cli run 5a486fc9-480a-4ccd-9017-10840e71f0ef --wait",
    );
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
