import type { AppConfig } from "../../src/config/schema.js";
import { parseConfigText } from "../../src/config/load.js";
import { openPersistence, type Persistence } from "../../src/db/index.js";
import { FakeBrowserAdapter } from "../../src/browser/fake/index.js";
import { createProxyRuntime, type ProxyRuntime } from "../../src/runtime.js";

export const TEST_API_TOKEN = "test-api-token";

export interface TestRuntime {
  readonly config: AppConfig;
  readonly adapter: FakeBrowserAdapter;
  readonly persistence: Persistence;
  readonly runtime: ProxyRuntime;
  close(): Promise<void>;
}

export function createTestConfig(
  remoteDeletionEnabled = false,
  requireApiToken = true,
): AppConfig {
  return parseConfigText(
    `
[server]
require_api_token = ${requireApiToken ? "true" : "false"}
api_token = "${requireApiToken ? TEST_API_TOKEN : ""}"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"
delete_remote_thread = ${remoteDeletionEnabled ? "true" : "false"}
`,
    { baseDirectory: "/tmp/chatgpt-proxy-tests" },
  );
}

export function createTestRuntime(
  remoteDeletionEnabled = false,
  requireApiToken = true,
): TestRuntime {
  const config = createTestConfig(remoteDeletionEnabled, requireApiToken);
  const adapter = new FakeBrowserAdapter();
  const persistence = openPersistence(":memory:");
  const runtime = createProxyRuntime({ config, adapter, persistence });

  return {
    config,
    adapter,
    persistence,
    runtime,
    async close() {
      await runtime.close();
      persistence.close();
    },
  };
}

export function authenticatedHeaders(
  additional: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${TEST_API_TOKEN}`,
    ...additional,
  };
}
