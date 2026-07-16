#!/usr/bin/env node

import { FakeBrowserAdapter } from "./browser/fake/index.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/index.js";
import { createProxyRuntime } from "./runtime.js";

const configPath = process.env.CHATGPT_PROXY_CONFIG ?? "./config.toml";
const config = await loadConfig(configPath);
const logger = createLogger();
const runtime = createProxyRuntime({
  config,
  adapter: new FakeBrowserAdapter(),
  logger,
});

await runtime.app.listen({
  host: config.server.listenHost,
  port: config.server.listenPort,
});
logger.info(
  {
    host: config.server.listenHost,
    port: config.server.listenPort,
    adapter: "fake",
  },
  "ChatGPT proxy server listening",
);
