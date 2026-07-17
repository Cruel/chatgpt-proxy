import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { createApiServer } from "./api/server.js";
import type { BrowserAdapter } from "./browser/adapter.js";
import type { AppConfig } from "./config/schema.js";
import { openPersistence, type Persistence } from "./db/index.js";
import { DurableRunQueue } from "./scheduler/index.js";
import {
  BrowserRunExecutor,
  DiagnosticArtifactStore,
  ProxyService,
} from "./service/index.js";

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
  const artifactStore = new DiagnosticArtifactStore({
    artifactDirectory: options.config.diagnostics.artifactDirectory,
    persistence,
    retainDays: options.config.diagnostics.retainDays,
  });
  const prunedArtifactCount = artifactStore.pruneExpired();
  if (prunedArtifactCount > 0) {
    options.logger?.info(
      { prunedArtifactCount },
      "expired diagnostic artifacts pruned",
    );
  }
  const executor = new BrowserRunExecutor({
    adapter: options.adapter,
    config: options.config,
    artifactStore,
  });
  const queue = new DurableRunQueue({
    persistence,
    executor,
    maxConcurrentRuns: options.config.browser.maxConcurrentRuns,
    maxQueueDepth: options.config.limits.maxQueueDepth,
    ...(options.adapter.operationGate === undefined
      ? {}
      : { dispatchGate: options.adapter.operationGate }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
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

  let closePromise: Promise<void> | null = null;

  return {
    app,
    persistence,
    queue,
    service,
    adapter: options.adapter,
    close() {
      if (closePromise !== null) {
        return closePromise;
      }
      closePromise = (async () => {
        const errors: unknown[] = [];
        for (const close of [
          () => app.close(),
          () => queue.close(),
          () => options.adapter.close?.() ?? Promise.resolve(),
        ]) {
          try {
            await close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (ownsPersistence) {
          try {
            persistence.close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Proxy runtime shutdown failed");
        }
      })();
      return closePromise;
    },
  };
}
