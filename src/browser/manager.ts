import { chmod, mkdir } from "node:fs/promises";

import type { Logger } from "pino";
import {
  chromium,
  type BrowserContext,
  type Page,
} from "playwright";

import type { AppConfig } from "../config/schema.js";
import type { BrowserStatus } from "../domain/states.js";
import type {
  BrowserOperationGate,
  BrowserStatusSnapshot,
} from "./adapter.js";
import {
  BrowserLifecycleError,
  BrowserOperationBlockedError,
} from "./errors.js";
import {
  PagePool,
  type PageLease,
} from "./page-pool.js";
import {
  ChatGptAuthenticationProbe,
  type BrowserStatusObservation,
  type BrowserStatusProbe,
} from "./status-probe.js";

type PersistentContextLaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

export type PersistentContextLauncher = (
  profileDirectory: string,
  options: PersistentContextLaunchOptions,
) => Promise<BrowserContext>;

export interface BrowserManagerOptions {
  readonly profileDirectory: string;
  readonly startupUrl: string;
  readonly headless: boolean;
  readonly maxConcurrentPages: number;
  readonly pageIdleTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly statusPollIntervalMs?: number;
  readonly recoveryDelaysMs?: readonly number[];
  readonly probe?: BrowserStatusProbe;
  readonly launchPersistentContext?: PersistentContextLauncher;
  readonly logger?: Pick<Logger, "debug" | "error" | "info" | "warn">;
}

export interface WaitForBrowserReadyOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type BrowserStatusListener = (snapshot: BrowserStatusSnapshot) => void;

const NOOP_LOGGER: Pick<Logger, "debug" | "error" | "info" | "warn"> = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

const DEFAULT_RECOVERY_DELAYS_MS = [0, 250, 1_000] as const;

function defaultLauncher(
  profileDirectory: string,
  options: PersistentContextLaunchOptions,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDirectory, options);
}

function statusDetail(status: BrowserStatus): string {
  switch (status) {
    case "starting":
      return "Persistent Chromium is starting";
    case "ready":
      return "Persistent Chromium is ready";
    case "auth_required":
      return "ChatGPT login is required";
    case "verification_required":
      return "Interactive browser verification is required";
    case "recovering":
      return "Persistent Chromium is recovering";
    case "unavailable":
      return "Persistent Chromium is unavailable";
    case "stopping":
      return "Persistent Chromium is stopping";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class BrowserManager {
  public readonly operationGate: BrowserOperationGate;

  private readonly profileDirectory: string;
  private readonly startupUrl: string;
  private readonly headless: boolean;
  private readonly maxConcurrentPages: number;
  private readonly pageIdleTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly statusPollIntervalMs: number;
  private readonly recoveryDelaysMs: readonly number[];
  private readonly probe: BrowserStatusProbe;
  private readonly launchPersistentContext: PersistentContextLauncher;
  private readonly logger: Pick<Logger, "debug" | "error" | "info" | "warn">;
  private readonly statusListeners = new Set<BrowserStatusListener>();
  private readonly gateListeners = new Set<() => void>();
  private readonly expectedContextClosures = new Set<number>();

  private context: BrowserContext | null = null;
  private controlPage: Page | null = null;
  private pagePool: PagePool | null = null;
  private status: BrowserStatus = "unavailable";
  private detail: string | null = "Browser manager has not started";
  private contextGeneration = 0;
  private startPromise: Promise<BrowserStatusSnapshot> | null = null;
  private recoveryPromise: Promise<BrowserStatusSnapshot> | null = null;
  private refreshPromise: Promise<BrowserStatusSnapshot> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private manualLoginNavigationPending = false;

  public constructor(options: BrowserManagerOptions) {
    if (!Number.isSafeInteger(options.maxConcurrentPages) || options.maxConcurrentPages < 1) {
      throw new Error("maxConcurrentPages must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.pageIdleTimeoutMs) || options.pageIdleTimeoutMs < 0) {
      throw new Error("pageIdleTimeoutMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(options.navigationTimeoutMs) || options.navigationTimeoutMs < 1) {
      throw new Error("navigationTimeoutMs must be a positive safe integer");
    }

    this.profileDirectory = options.profileDirectory;
    this.startupUrl = options.startupUrl;
    this.headless = options.headless;
    this.maxConcurrentPages = options.maxConcurrentPages;
    this.pageIdleTimeoutMs = options.pageIdleTimeoutMs;
    this.navigationTimeoutMs = options.navigationTimeoutMs;
    this.statusPollIntervalMs = options.statusPollIntervalMs ?? 1_000;
    this.recoveryDelaysMs = options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS;
    this.probe = options.probe ?? new ChatGptAuthenticationProbe();
    this.launchPersistentContext =
      options.launchPersistentContext ?? defaultLauncher;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.operationGate = {
      canDispatch: () => this.status === "ready",
      onChange: (listener) => {
        this.gateListeners.add(listener);
        return () => this.gateListeners.delete(listener);
      },
    };
  }

  public get currentStatus(): BrowserStatus {
    return this.status;
  }

  public get isHeadless(): boolean {
    return this.headless;
  }

  public getStatus(queuedRunCount = 0): BrowserStatusSnapshot {
    return {
      status: this.status,
      detail: this.detail,
      activePageCount: this.pagePool?.activePageCount ?? 0,
      queuedRunCount,
      observedAt: new Date().toISOString(),
    };
  }

  public onStatusChange(listener: BrowserStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public start(): Promise<BrowserStatusSnapshot> {
    if (this.stopping) {
      return Promise.reject(
        new BrowserLifecycleError("Browser manager is stopping"),
      );
    }
    if (this.context !== null) {
      return Promise.resolve(this.getStatus());
    }
    if (this.startPromise !== null) {
      return this.startPromise;
    }

    this.startPromise = this.launchFreshContext("starting")
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  public async leasePage(signal?: AbortSignal): Promise<PageLease> {
    await this.start();
    const snapshot = await this.refreshStatus();
    if (snapshot.status !== "ready") {
      throw new BrowserOperationBlockedError(
        snapshot.status,
        snapshot.detail ?? statusDetail(snapshot.status),
      );
    }

    const pool = this.pagePool;
    if (pool === null) {
      throw new BrowserOperationBlockedError(
        "unavailable",
        "Browser page pool is unavailable",
      );
    }
    return pool.lease(signal);
  }

  public async reportPageStatus(page: Page): Promise<BrowserStatusSnapshot> {
    const observation = await this.probe.inspect(page);
    this.applyObservation(observation);
    if (
      observation.status === "auth_required" ||
      observation.status === "verification_required"
    ) {
      void this.prepareControlPageForManualLogin();
    }
    return this.getStatus();
  }

  public refreshStatus(): Promise<BrowserStatusSnapshot> {
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performStatusRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  public async showManualLoginPage(): Promise<BrowserStatusSnapshot> {
    await this.start();
    await this.prepareControlPageForManualLogin();
    return this.refreshStatus();
  }

  public async waitForReady(
    options: WaitForBrowserReadyOptions = {},
  ): Promise<BrowserStatusSnapshot> {
    await this.start();
    const initial = await this.refreshStatus();
    if (initial.status === "ready") {
      return initial;
    }
    if (options.signal?.aborted === true) {
      throw new BrowserLifecycleError("Waiting for browser readiness was aborted");
    }

    return new Promise<BrowserStatusSnapshot>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new BrowserLifecycleError("Waiting for browser readiness was aborted"));
      };
      unsubscribe = this.onStatusChange((snapshot) => {
        if (snapshot.status === "ready") {
          cleanup();
          resolve(snapshot);
        }
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          reject(
            new BrowserLifecycleError(
              `Browser did not become ready within ${options.timeoutMs} ms`,
            ),
          );
        }, options.timeoutMs);
        timeout.unref();
      }
    });
  }

  public recover(reason = "Browser recovery requested"): Promise<BrowserStatusSnapshot> {
    if (this.stopping) {
      return Promise.reject(
        new BrowserLifecycleError("Browser manager is stopping"),
      );
    }
    if (this.recoveryPromise !== null) {
      return this.recoveryPromise;
    }

    this.recoveryPromise = this.performRecovery(reason).finally(() => {
      this.recoveryPromise = null;
    });
    return this.recoveryPromise;
  }

  public async close(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.setStatus("stopping", statusDetail("stopping"));
    this.stopPolling();
    await this.closeCurrentContext(true);
  }

  private async launchFreshContext(
    launchStatus: Extract<BrowserStatus, "starting" | "recovering">,
  ): Promise<BrowserStatusSnapshot> {
    this.setStatus(launchStatus, statusDetail(launchStatus));
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.profileDirectory, 0o700);

    let context: BrowserContext;
    try {
      context = await this.launchPersistentContext(this.profileDirectory, {
        headless: this.headless,
        viewport: null,
      });
    } catch (error) {
      this.setStatus("unavailable", "Failed to launch persistent Chromium");
      throw new BrowserLifecycleError(
        "Failed to launch persistent Chromium",
        error,
      );
    }

    const generation = this.contextGeneration + 1;
    this.contextGeneration = generation;
    this.context = context;
    context.once("close", () => this.handleContextClosed(generation));

    const existingPages = context.pages();
    const controlPage = existingPages[0] ?? (await context.newPage());
    for (const extraPage of existingPages.slice(1)) {
      await extraPage.close({ runBeforeUnload: false }).catch(() => undefined);
    }
    this.controlPage = controlPage;
    this.configureControlPage(controlPage, generation);
    this.pagePool = new PagePool({
      context,
      maxPages: this.maxConcurrentPages,
      idleTimeoutMs: this.pageIdleTimeoutMs,
      navigationTimeoutMs: this.navigationTimeoutMs,
    });

    try {
      await controlPage.goto(this.startupUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
    } catch (error) {
      this.logger.warn(
        { error, startupUrl: this.startupUrl },
        "browser startup navigation failed",
      );
    }

    const observation = await this.probe.inspect(controlPage);
    this.applyObservation(observation);
    this.startPolling();
    return this.getStatus();
  }

  private async performStatusRefresh(): Promise<BrowserStatusSnapshot> {
    if (this.stopping) {
      return this.getStatus();
    }
    if (this.context === null) {
      if (this.startPromise !== null) {
        return this.startPromise;
      }
      if (this.recoveryPromise !== null) {
        return this.recoveryPromise;
      }
      if (this.contextGeneration === 0) {
        return this.start();
      }
      return this.recover("Browser context was unavailable during status refresh");
    }

    const page = await this.ensureControlPage();
    try {
      const observation = await this.probe.inspect(page);
      if (
        this.manualLoginNavigationPending &&
        observation.status === "ready" &&
        (this.status === "auth_required" ||
          this.status === "verification_required")
      ) {
        return this.getStatus();
      }
      this.applyObservation(observation);
    } catch (error) {
      this.logger.warn({ error }, "browser status probe failed");
      this.setStatus("unavailable", "Browser status probe failed");
    }
    return this.getStatus();
  }

  private async performRecovery(reason: string): Promise<BrowserStatusSnapshot> {
    this.logger.warn({ reason }, "recovering persistent browser context");
    this.setStatus("recovering", reason);
    this.stopPolling();
    await this.closeCurrentContext(true);

    let lastError: unknown;
    for (const recoveryDelay of this.recoveryDelaysMs) {
      if (recoveryDelay > 0) {
        await delay(recoveryDelay);
      }
      if (this.stopping) {
        return this.getStatus();
      }
      try {
        return await this.launchFreshContext("recovering");
      } catch (error) {
        lastError = error;
        this.logger.warn(
          { error, recoveryDelay },
          "persistent browser recovery attempt failed",
        );
      }
    }

    this.setStatus("unavailable", "Persistent Chromium recovery failed");
    throw new BrowserLifecycleError(
      "Persistent Chromium recovery failed",
      lastError,
    );
  }

  private async closeCurrentContext(expected: boolean): Promise<void> {
    const pool = this.pagePool;
    const context = this.context;
    const generation = this.contextGeneration;
    this.pagePool = null;
    this.controlPage = null;
    this.context = null;
    if (expected && context !== null) {
      this.expectedContextClosures.add(generation);
    }

    await pool?.close().catch((error: unknown) => {
      this.logger.warn({ error }, "failed to close browser page pool cleanly");
    });
    await context?.close().catch((error: unknown) => {
      this.logger.warn({ error }, "failed to close browser context cleanly");
    });
  }

  private handleContextClosed(generation: number): void {
    if (this.expectedContextClosures.delete(generation)) {
      return;
    }
    if (this.stopping || generation !== this.contextGeneration) {
      return;
    }

    const pool = this.pagePool;
    this.context = null;
    this.controlPage = null;
    this.pagePool = null;
    void pool?.close().catch(() => undefined);
    this.setStatus("recovering", "Persistent Chromium closed unexpectedly");
    void this.recover("Persistent Chromium closed unexpectedly").catch(
      (error: unknown) => {
        this.logger.error({ error }, "automatic browser recovery failed");
      },
    );
  }

  private async ensureControlPage(): Promise<Page> {
    const current = this.controlPage;
    if (current !== null && !current.isClosed()) {
      return current;
    }

    const context = this.context;
    if (context === null) {
      throw new BrowserLifecycleError("Browser context is unavailable");
    }
    const page = await context.newPage();
    this.controlPage = page;
    this.configureControlPage(page, this.contextGeneration);
    await page.goto(this.startupUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.navigationTimeoutMs,
    });
    return page;
  }

  private configureControlPage(page: Page, generation: number): void {
    page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    page.setDefaultTimeout(this.navigationTimeoutMs);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        void this.refreshStatus().catch(() => undefined);
      }
    });
    page.once("close", () => {
      if (
        this.stopping ||
        generation !== this.contextGeneration ||
        this.context === null
      ) {
        return;
      }
      this.controlPage = null;
      void this.refreshStatus().catch((error: unknown) => {
        this.logger.warn({ error }, "failed to recreate browser control page");
      });
    });
  }

  private async prepareControlPageForManualLogin(): Promise<void> {
    if (this.context === null || this.stopping) {
      return;
    }
    this.manualLoginNavigationPending = true;
    try {
      const page = await this.ensureControlPage();
      await page.goto(this.startupUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
      if (!this.headless) {
        await page.bringToFront();
      }
    } catch (error) {
      this.logger.warn({ error }, "failed to prepare manual login page");
    } finally {
      this.manualLoginNavigationPending = false;
      void this.refreshStatus().catch(() => undefined);
    }
  }

  private applyObservation(observation: BrowserStatusObservation): void {
    this.setStatus(
      observation.status,
      observation.detail ?? statusDetail(observation.status),
    );
  }

  private setStatus(status: BrowserStatus, detail: string | null): void {
    const changed = this.status !== status || this.detail !== detail;
    const gateChanged = (this.status === "ready") !== (status === "ready");
    this.status = status;
    this.detail = detail;
    if (!changed) {
      return;
    }

    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      listener(snapshot);
    }
    if (gateChanged) {
      for (const listener of this.gateListeners) {
        listener();
      }
    }
  }

  private startPolling(): void {
    this.stopPolling();
    if (this.statusPollIntervalMs <= 0) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.refreshStatus().catch((error: unknown) => {
        this.logger.debug({ error }, "periodic browser status refresh failed");
      });
    }, this.statusPollIntervalMs);
    this.pollTimer.unref();
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export function createBrowserManagerFromConfig(
  config: AppConfig,
  logger?: Pick<Logger, "debug" | "error" | "info" | "warn">,
): BrowserManager {
  return new BrowserManager(
    logger === undefined
      ? {
          profileDirectory: config.chatGpt.profileDirectory,
          startupUrl: config.chatGpt.projectUrl,
          headless: config.chatGpt.headless,
          maxConcurrentPages: config.browser.maxConcurrentRuns,
          pageIdleTimeoutMs: config.browser.pageIdleTimeoutSeconds * 1_000,
          navigationTimeoutMs: config.browser.navigationTimeoutSeconds * 1_000,
        }
      : {
          profileDirectory: config.chatGpt.profileDirectory,
          startupUrl: config.chatGpt.projectUrl,
          headless: config.chatGpt.headless,
          maxConcurrentPages: config.browser.maxConcurrentRuns,
          pageIdleTimeoutMs: config.browser.pageIdleTimeoutSeconds * 1_000,
          navigationTimeoutMs: config.browser.navigationTimeoutSeconds * 1_000,
          logger,
        },
  );
}
