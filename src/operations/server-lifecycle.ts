import type { FastifyBaseLogger } from "fastify";

import type { AppConfig } from "../config/schema.js";
import type { ProxyRuntime } from "../runtime.js";
import type { OperationalDiagnosticsReport } from "./diagnostics.js";

export interface ProcessSignalSource {
  on(event: NodeJS.Signals, listener: () => void): this;
  off(event: NodeJS.Signals, listener: () => void): this;
}

export interface GracefulShutdownController {
  request(signal: NodeJS.Signals | "manual"): Promise<void>;
  dispose(): void;
}

export interface InstallGracefulShutdownOptions {
  readonly runtime: ProxyRuntime;
  readonly logger: Pick<FastifyBaseLogger, "error" | "info" | "warn">;
  readonly signalSource?: ProcessSignalSource;
  readonly forceExit?: (exitCode: number) => void;
}

export interface StartProxyServerOptions {
  readonly runtime: ProxyRuntime;
  readonly config: AppConfig;
  readonly logger: Pick<FastifyBaseLogger, "error" | "info" | "warn">;
  readonly adapterName: string;
  readonly signalSource?: ProcessSignalSource;
  readonly forceExit?: (exitCode: number) => void;
}

export interface StartedProxyServer {
  readonly diagnostics: OperationalDiagnosticsReport;
  readonly shutdown: GracefulShutdownController;
}

export function logOperationalDiagnostics(
  logger: Pick<FastifyBaseLogger, "error" | "info" | "warn">,
  report: OperationalDiagnosticsReport,
): void {
  for (const diagnostic of report.checks) {
    const fields = {
      diagnosticId: diagnostic.id,
      status: diagnostic.status,
      detail: diagnostic.detail,
      remediation: diagnostic.remediation,
    };
    if (diagnostic.status === "error") {
      logger.error(fields, diagnostic.summary);
    } else if (diagnostic.status === "warning") {
      logger.warn(fields, diagnostic.summary);
    } else {
      logger.info(fields, diagnostic.summary);
    }
  }
}

export function installGracefulShutdown(
  options: InstallGracefulShutdownOptions,
): GracefulShutdownController {
  const signalSource = options.signalSource ?? process;
  const forceExit = options.forceExit ?? ((exitCode) => process.exit(exitCode));
  let shutdownPromise: Promise<void> | null = null;
  let forced = false;
  let initiatingSignal: NodeJS.Signals | "manual" | null = null;

  const request = (signal: NodeJS.Signals | "manual"): Promise<void> => {
    if (shutdownPromise !== null) {
      if (
        !forced &&
        signal !== "manual" &&
        signal === initiatingSignal
      ) {
        forced = true;
        options.logger.warn(
          { signal },
          "second shutdown signal received; forcing process exit",
        );
        forceExit(1);
      } else if (signal !== "manual" && signal !== initiatingSignal) {
        options.logger.info(
          { signal, initiatingSignal },
          "additional wrapper shutdown signal ignored while graceful shutdown is in progress",
        );
      }
      return shutdownPromise;
    }

    initiatingSignal = signal;
    const queue = options.runtime.queue.getSnapshot();
    options.logger.info(
      {
        signal,
        activeRunCount: queue.activeRunCount,
        queuedRunCount: queue.queuedRunCount,
      },
      "graceful shutdown started; HTTP intake will stop, active work will finish, and undispatched durable runs will remain queued for restart",
    );
    shutdownPromise = options.runtime
      .close()
      .then(() => {
        options.logger.info({ signal }, "graceful shutdown completed");
      })
      .catch((error: unknown) => {
        options.logger.error({ error, signal }, "graceful shutdown failed");
        throw error;
      });
    return shutdownPromise;
  };

  const onSigint = () => {
    void request("SIGINT").catch(() => {
      process.exitCode = 1;
    });
  };
  const onSigterm = () => {
    void request("SIGTERM").catch(() => {
      process.exitCode = 1;
    });
  };
  const onSighup = () => {
    void request("SIGHUP").catch(() => {
      process.exitCode = 1;
    });
  };
  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);
  signalSource.on("SIGHUP", onSighup);

  return {
    request,
    dispose() {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      signalSource.off("SIGHUP", onSighup);
    },
  };
}

export async function startProxyServer(
  options: StartProxyServerOptions,
): Promise<StartedProxyServer> {
  const diagnostics = await options.runtime.service.getDoctorReport();
  logOperationalDiagnostics(options.logger, diagnostics);
  await options.runtime.app.listen({
    host: options.config.server.listenHost,
    port: options.config.server.listenPort,
  });
  const shutdown = installGracefulShutdown({
    runtime: options.runtime,
    logger: options.logger,
    ...(options.signalSource === undefined
      ? {}
      : { signalSource: options.signalSource }),
    ...(options.forceExit === undefined ? {} : { forceExit: options.forceExit }),
  });
  options.logger.info(
    {
      host: options.config.server.listenHost,
      port: options.config.server.listenPort,
      adapter: options.adapterName,
      operationalStatus: diagnostics.status,
      browserStatus: diagnostics.browser.status,
      browserDetail: diagnostics.browser.detail,
    },
    "ChatGPT proxy server listening",
  );
  return { diagnostics, shutdown };
}
