import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { createApiServer } from "./api/server.js";
import type { BrowserAdapter } from "./browser/adapter.js";
import type { AppConfig } from "./config/schema.js";
import { openPersistence, type Persistence } from "./db/index.js";
import { DurableRunQueue } from "./scheduler/index.js";
import { BrowserRunExecutor, ProxyService } from "./service/index.js";

export interface CreateProxyRuntimeOptions {
  readonly config: AppConfig;
  readonly adapter: BrowserAdapter;
  readonly persistence?: Persistence;
  readonly logger?: FastifyBaseLogger;
}

export interface ProxyRuntime {
  readonly app: FastifyInstance;
  readonly persistence: Persistence;
  readonly queue: DurableRunQueue;
  readonly service: ProxyService;
  readonly adapter: BrowserAdapter;
  close(): Promise<void>;
}

export function createProxyRuntime(
  options: CreateProxyRuntimeOptions,
): ProxyRuntime {
  const ownsPersistence = options.persistence === undefined;
  const persistence =
    options.persistence ?? openPersistence(options.config.database.path);
  const executor = new BrowserRunExecutor({
    adapter: options.adapter,
    config: options.config,
  });
  const queue = new DurableRunQueue(
    options.logger === undefined
      ? {
          persistence,
          executor,
          maxConcurrentRuns: options.config.browser.maxConcurrentRuns,
          maxQueueDepth: options.config.limits.maxQueueDepth,
        }
      : {
          persistence,
          executor,
          maxConcurrentRuns: options.config.browser.maxConcurrentRuns,
          maxQueueDepth: options.config.limits.maxQueueDepth,
          logger: options.logger,
        },
  );
  queue.start();
  const service = new ProxyService(
    options.config,
    persistence,
    queue,
    options.adapter,
  );
  const app = createApiServer(
    options.logger === undefined
      ? { config: options.config, service }
      : { config: options.config, service, logger: options.logger },
  );

  return {
    app,
    persistence,
    queue,
    service,
    adapter: options.adapter,
    async close() {
      await app.close();
      await queue.close();
      if (ownsPersistence) {
        persistence.close();
      }
    },
  };
}
