#!/usr/bin/env node

import { FakeBrowserAdapter } from "./browser/fake/index.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/index.js";
import { startProxyServer } from "./operations/index.js";
import { createProxyRuntime } from "./runtime.js";

const logger = createLogger();
let runtime: ReturnType<typeof createProxyRuntime> | null = null;

try {
  const configPath = process.env.CHATGPT_PROXY_CONFIG ?? "./config.toml";
  const config = await loadConfig(configPath);
  runtime = createProxyRuntime({
    config,
    adapter: new FakeBrowserAdapter(),
    logger,
  });
  await startProxyServer({ runtime, config, logger, adapterName: "fake" });
} catch (error) {
  await runtime?.close().catch(() => undefined);
  logger.fatal({ error }, "ChatGPT proxy failed to start");
  process.exitCode = 1;
}
