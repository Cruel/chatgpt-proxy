#!/usr/bin/env node

import { createChatGptBrowserAdapterFromConfig } from "./browser/index.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/index.js";
import { createProxyRuntime } from "./runtime.js";

const configPath = process.env.CHATGPT_PROXY_CONFIG ?? "./config.toml";
const config = await loadConfig(configPath);
const logger = createLogger();
const adapter = createChatGptBrowserAdapterFromConfig(config, logger);
const browserStatus = await adapter.start();
const runtime = createProxyRuntime({ config, adapter, logger });

await runtime.app.listen({
  host: config.server.listenHost,
  port: config.server.listenPort,
});
logger.info(
  {
    host: config.server.listenHost,
    port: config.server.listenPort,
    adapter: "playwright",
    browserStatus: browserStatus.status,
    browserDetail: browserStatus.detail,
  },
  "ChatGPT proxy server listening",
);
