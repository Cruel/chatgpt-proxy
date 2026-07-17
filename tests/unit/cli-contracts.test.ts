import { describe, expect, it } from "vitest";

import type {
  CliCommandExecutor,
  CliInvocation,
} from "../../src/cli/contracts.js";
import { runCli } from "../../src/cli/program.js";

function recordingExecutor(invocations: CliInvocation[]): CliCommandExecutor {
  return {
    execute(invocation) {
      invocations.push(invocation);
      return Promise.resolve();
    },
  };
}

describe("CLI command contracts", () => {
  it("parses the doctor command as an authenticated operational request", async () => {
    const invocations: CliInvocation[] = [];

    await runCli(["doctor"], recordingExecutor(invocations));

    expect(invocations[0]?.command).toEqual({ kind: "doctor" });
  });

  it("parses a new-thread command into a transport-independent invocation", async () => {
    const invocations: CliInvocation[] = [];

    await runCli(
      [
        "--json",
        "new",
        "renderer-review",
        "--message",
        "Review the renderer.",
        "--no-wait",
      ],
      recordingExecutor(invocations),
    );

    expect(invocations).toEqual([
      {
        command: {
          kind: "new",
          name: "renderer-review",
          input: { kind: "message", value: "Review the renderer." },
          wait: false,
          idempotencyKey: undefined,
        },
        options: {
          serverUrl: "http://127.0.0.1:7421",
          apiToken: undefined,
          json: true,
          timeout: undefined,
        },
      },
    ]);
  });

  it("keeps remote deletion explicit", async () => {
    const invocations: CliInvocation[] = [];

    await runCli(
      ["delete", "renderer-review", "--remote", "--yes"],
      recordingExecutor(invocations),
    );

    expect(invocations[0]?.command).toEqual({
      kind: "delete",
      name: "renderer-review",
      remote: true,
      yes: true,
      wait: true,
      idempotencyKey: undefined,
    });
  });

  it("rejects prompt commands without exactly one input source", async () => {
    await expect(
      runCli(["chat", "renderer-review"], recordingExecutor([])),
    ).rejects.toThrow(/Exactly one/);
  });
});
