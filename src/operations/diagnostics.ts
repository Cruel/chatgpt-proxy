import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";

import type { BrowserAdapter, BrowserStatusSnapshot } from "../browser/adapter.js";
import type { AppConfig } from "../config/schema.js";
import type { Persistence } from "../db/persistence.js";
import type {
  DurableRunQueue,
  DurableRunQueueSnapshot,
} from "../scheduler/durable-run-queue.js";
import { APP_VERSION } from "../version.js";

export type OperationalCheckStatus = "ok" | "warning" | "error";
export type OperationalStatus = OperationalCheckStatus;

export interface OperationalCheck {
  readonly id: string;
  readonly status: OperationalCheckStatus;
  readonly summary: string;
  readonly detail: string | null;
  readonly remediation: string | null;
}

export interface OperationalDiagnosticsReport {
  readonly status: OperationalStatus;
  readonly version: string;
  readonly observedAt: string;
  readonly checks: readonly OperationalCheck[];
  readonly browser: BrowserStatusSnapshot;
  readonly queue: DurableRunQueueSnapshot;
}

export interface OperationalDiagnosticsOptions {
  readonly config: AppConfig;
  readonly persistence: Persistence;
  readonly queue: DurableRunQueue;
  readonly adapter: BrowserAdapter;
}

function aggregateStatus(
  checks: readonly OperationalCheck[],
): OperationalStatus {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }
  return checks.some((check) => check.status === "warning")
    ? "warning"
    : "ok";
}

function check(
  id: string,
  status: OperationalCheckStatus,
  summary: string,
  detail: string | null = null,
  remediation: string | null = null,
): OperationalCheck {
  return { id, status, summary, detail, remediation };
}

async function inspectDirectory(
  id: string,
  label: string,
  path: string,
): Promise<OperationalCheck> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) {
      return check(
        id,
        "error",
        `${label} is not a directory`,
        path,
        "Update the configured path to a private directory on the Linux/WSL filesystem.",
      );
    }
    await access(path, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    const exposedBits = metadata.mode & 0o077;
    if (exposedBits !== 0) {
      return check(
        id,
        "warning",
        `${label} permissions are broader than recommended`,
        `${path} has mode ${(metadata.mode & 0o777).toString(8)}`,
        `Run chmod 700 ${JSON.stringify(path)} while the service is stopped.`,
      );
    }
    return check(id, "ok", `${label} is private and writable`, path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return check(
      id,
      "error",
      `${label} is unavailable`,
      `${path}: ${detail}`,
      "Create the directory, ensure the current user owns it, and keep it on the Linux/WSL filesystem.",
    );
  }
}

async function inspectDatabase(
  config: AppConfig,
  persistence: Persistence,
): Promise<readonly OperationalCheck[]> {
  const checks: OperationalCheck[] = [];
  try {
    const result = persistence.database.pragma("quick_check", { simple: true });
    if (result === "ok") {
      checks.push(check("database_integrity", "ok", "SQLite quick check passed"));
    } else {
      checks.push(
        check(
          "database_integrity",
          "error",
          "SQLite quick check reported a problem",
          String(result),
          "Stop the service, preserve the database and WAL files, and restore from a known-good backup.",
        ),
      );
    }
  } catch (error) {
    checks.push(
      check(
        "database_integrity",
        "error",
        "SQLite quick check failed to run",
        error instanceof Error ? error.message : String(error),
        "Verify database ownership, free disk space, and filesystem health before restarting the service.",
      ),
    );
  }

  if (config.database.path === ":memory:") {
    checks.push(
      check(
        "database_permissions",
        "warning",
        "SQLite is using an in-memory database",
        null,
        "Use a persistent database path for long-running service operation.",
      ),
    );
    return checks;
  }

  try {
    const metadata = await stat(config.database.path);
    const exposedBits = metadata.mode & 0o077;
    checks.push(
      exposedBits === 0
        ? check(
            "database_permissions",
            "ok",
            "SQLite database permissions are private",
            config.database.path,
          )
        : check(
            "database_permissions",
            "warning",
            "SQLite database permissions are broader than recommended",
            `${config.database.path} has mode ${(metadata.mode & 0o777).toString(8)}`,
            `Run chmod 600 ${JSON.stringify(config.database.path)} while the service is stopped.`,
          ),
    );
  } catch (error) {
    checks.push(
      check(
        "database_permissions",
        "error",
        "SQLite database file cannot be inspected",
        error instanceof Error ? error.message : String(error),
        "Verify that the configured database path exists and is owned by the service user.",
      ),
    );
  }
  return checks;
}

function browserCheck(browser: BrowserStatusSnapshot): OperationalCheck {
  switch (browser.status) {
    case "ready":
      return check("browser", "ok", "Browser profile is authenticated and ready");
    case "auth_required":
      return check(
        "browser",
        "warning",
        "ChatGPT login is required",
        browser.detail,
        "Complete login in the headed browser window. Queued runs remain durable and will resume after readiness is verified.",
      );
    case "verification_required":
      return check(
        "browser",
        "warning",
        "Interactive browser verification is required",
        browser.detail,
        "Complete the visible verification in the headed browser window. Do not restart or resubmit queued prompts.",
      );
    case "starting":
    case "recovering":
      return check(
        "browser",
        "warning",
        `Browser is ${browser.status}`,
        browser.detail,
        "Wait for browser recovery, then rerun cgpt doctor if the state does not become ready.",
      );
    case "stopping":
      return check(
        "browser",
        "warning",
        "Browser is stopping",
        browser.detail,
        "Wait for graceful shutdown to complete before restarting the service.",
      );
    case "unavailable":
      return check(
        "browser",
        "error",
        "Browser is unavailable",
        browser.detail,
        "Inspect the service log and diagnostics, verify the configured browser channel is installed, and rerun pnpm auth if authentication storage is damaged.",
      );
  }
}

function queueCheck(queue: DurableRunQueueSnapshot): OperationalCheck {
  if (queue.state === "running") {
    return check(
      "queue",
      queue.dispatchEnabled ? "ok" : "warning",
      queue.dispatchEnabled
        ? "Durable queue is running"
        : "Durable queue is paused by browser readiness",
      `${queue.activeRunCount} active, ${queue.queuedRunCount} queued`,
      queue.dispatchEnabled
        ? null
        : "Resolve the browser status shown above; queued runs will resume without being resubmitted.",
    );
  }
  return check(
    "queue",
    queue.state === "not_started" ? "error" : "warning",
    `Durable queue is ${queue.state.replaceAll("_", " ")}`,
    `${queue.activeRunCount} active, ${queue.queuedRunCount} queued`,
    queue.state === "not_started"
      ? "Restart the service and inspect startup errors."
      : "Wait for shutdown to finish before restarting the service.",
  );
}

function configurationChecks(config: AppConfig): readonly OperationalCheck[] {
  const checks: OperationalCheck[] = [];
  const normalizedToken = config.server.apiToken.trim().toLowerCase();
  const placeholderToken = new Set([
    "replace-me",
    "changeme",
    "change-me",
    "test-api-token",
  ]).has(normalizedToken);
  checks.push(
    !config.server.requireApiToken
      ? check(
          "api_token",
          "warning",
          "API authentication is disabled",
          "The service accepts unauthenticated requests from local processes and browser pages that can reach the loopback listener.",
          "Enable server.require_api_token and configure a strong token for stricter local isolation.",
        )
      : placeholderToken
      ? check(
          "api_token",
          "warning",
          "API token appears to be a placeholder",
          null,
          "Replace it with a long random value before relying on the service for unattended operation.",
        )
      : check("api_token", "ok", "API token is configured"),
  );
  checks.push(
    config.chatGpt.deleteRemoteThread
      ? check(
          "remote_deletion",
          "warning",
          "Remote conversation deletion is enabled",
          null,
          "Keep this disabled unless remote deletion is actively required; every request still needs an explicit remote-delete flag.",
        )
      : check(
          "remote_deletion",
          "ok",
          "Remote conversation deletion is disabled by default",
        ),
  );
  return checks;
}

export async function runOperationalDiagnostics(
  options: OperationalDiagnosticsOptions,
): Promise<OperationalDiagnosticsReport> {
  const [browser, profile, artifacts, database] = await Promise.all([
    options.adapter.getStatus(),
    inspectDirectory(
      "profile_directory",
      "Browser profile directory",
      options.config.chatGpt.profileDirectory,
    ),
    inspectDirectory(
      "artifact_directory",
      "Diagnostic artifact directory",
      options.config.diagnostics.artifactDirectory,
    ),
    inspectDatabase(options.config, options.persistence),
  ]);
  const queue = options.queue.getSnapshot();
  const checks = [
    ...configurationChecks(options.config),
    ...database,
    profile,
    artifacts,
    browserCheck(browser),
    queueCheck(queue),
  ];
  return {
    status: aggregateStatus(checks),
    version: APP_VERSION,
    observedAt: new Date().toISOString(),
    checks,
    browser,
    queue,
  };
}
