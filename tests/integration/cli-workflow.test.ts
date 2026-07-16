import { afterEach, describe, expect, it } from "vitest";

import { HttpCliExecutor } from "../../src/cli/http-client.js";
import { runCli } from "../../src/cli/program.js";
import type { TestRuntime } from "../helpers/test-runtime.js";
import {
  createTestRuntime,
  TEST_API_TOKEN,
} from "../helpers/test-runtime.js";

const openRuntimes: TestRuntime[] = [];

afterEach(async () => {
  while (openRuntimes.length > 0) {
    await openRuntimes.pop()?.close();
  }
});

function outputCollector(): {
  readonly stream: { write(text: string | Uint8Array): boolean };
  read(): string;
  clear(): void;
} {
  let output = "";
  return {
    stream: {
      write(text) {
        output += String(text);
        return true;
      },
    },
    read: () => output,
    clear: () => {
      output = "";
    },
  };
}

describe("CLI and API integration", () => {
  it("performs the complete local workflow over HTTP", async () => {
    const testRuntime = createTestRuntime();
    openRuntimes.push(testRuntime);
    const serverUrl = await testRuntime.runtime.app.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const output = outputCollector();
    const executor = new HttpCliExecutor({ stdout: output.stream });
    const global = [
      "--server-url",
      serverUrl,
      "--api-token",
      TEST_API_TOKEN,
      "--json",
    ];

    await runCli(
      [
        ...global,
        "new",
        "cli-review",
        "--message",
        "Review through the CLI.",
      ],
      executor,
    );
    const created = JSON.parse(output.read()) as {
      run: { id: string; state: string; finalResponse: string };
      thread: { state: string };
    };
    expect(created.run.state).toBe("succeeded");
    expect(created.run.finalResponse).toBe(
      "Fake response: Review through the CLI.",
    );
    output.clear();

    await runCli(
      [
        ...global,
        "chat",
        "cli-review",
        "--message",
        "Continue through the CLI.",
      ],
      executor,
    );
    const chatted = JSON.parse(output.read()) as {
      run: { id: string; state: string; finalResponse: string };
    };
    expect(chatted.run.state).toBe("succeeded");
    output.clear();

    await runCli([...global, "run", chatted.run.id], executor);
    expect((JSON.parse(output.read()) as { run: { state: string } }).run.state).toBe(
      "succeeded",
    );
    output.clear();

    await runCli([...global, "info", "cli-review"], executor);
    expect(
      (JSON.parse(output.read()) as { history: unknown[] }).history,
    ).toHaveLength(2);
    output.clear();

    await runCli([...global, "threads"], executor);
    expect(
      (JSON.parse(output.read()) as { threads: unknown[] }).threads,
    ).toHaveLength(1);
    output.clear();

    await runCli([...global, "delete", "cli-review"], executor);
    expect(
      (JSON.parse(output.read()) as { thread: { state: string } }).thread.state,
    ).toBe("deleted_local");
    expect(testRuntime.adapter.deleteCalls).toHaveLength(0);
  });
});
