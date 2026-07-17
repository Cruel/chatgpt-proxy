#!/usr/bin/env node

import { createChatGptBrowserAdapterFromConfig } from "./browser/index.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/index.js";
import { startProxyServer } from "./operations/index.js";
import { createProxyRuntime } from "./runtime.js";

const logger = createLogger();
let runtime: ReturnType<typeof createProxyRuntime> | null = null;
let adapter: ReturnType<typeof createChatGptBrowserAdapterFromConfig> | null = null;

try {
  const configPath = process.env.CHATGPT_PROXY_CONFIG ?? "./config.toml";
  const config = await loadConfig(configPath);
  adapter = createChatGptBrowserAdapterFromConfig(config, logger);
  await adapter.start();
  runtime = createProxyRuntime({ config, adapter, logger });
  await startProxyServer({
    runtime,
    config,
    logger,
    adapterName: "playwright",
  });
} catch (error) {
  if (runtime !== null) {
    await runtime.close().catch(() => undefined);
  } else {
    await adapter?.close().catch(() => undefined);
  }
  logger.fatal({ error }, "ChatGPT proxy failed to start");
  process.exitCode = 1;
}
