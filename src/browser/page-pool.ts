import type { BrowserContext, Page } from "playwright";

import {
  PageLeaseAbortedError,
  PagePoolClosedError,
} from "./errors.js";

export interface PageLeaseReleaseOptions {
  readonly discard?: boolean;
}

export interface PageLease {
  readonly page: Page;
  release(options?: PageLeaseReleaseOptions): Promise<void>;
}

export interface PagePoolOptions {
  readonly context: BrowserContext;
  readonly maxPages: number;
  readonly idleTimeoutMs: number;
  readonly navigationTimeoutMs: number;
}

interface IdlePage {
  readonly page: Page;
  readonly timer: NodeJS.Timeout;
}

interface LeaseWaiter {
  readonly resolve: (lease: PageLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
}

export class PagePool {
  private readonly context: BrowserContext;
  private readonly maxPages: number;
  private readonly idleTimeoutMs: number;
  private readonly navigationTimeoutMs: number;
  private readonly pages = new Set<Page>();
  private readonly activePages = new Set<Page>();
  private readonly idlePages: IdlePage[] = [];
  private readonly waiters: LeaseWaiter[] = [];
  private creatingPages = 0;
  private closed = false;

  public constructor(options: PagePoolOptions) {
    if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) {
      throw new Error("Page pool maxPages must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 0) {
      throw new Error("Page pool idleTimeoutMs must be a non-negative safe integer");
    }
    if (
      !Number.isSafeInteger(options.navigationTimeoutMs) ||
      options.navigationTimeoutMs < 1
    ) {
      throw new Error(
        "Page pool navigationTimeoutMs must be a positive safe integer",
      );
    }

    this.context = options.context;
    this.maxPages = options.maxPages;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.navigationTimeoutMs = options.navigationTimeoutMs;
  }

  public get activePageCount(): number {
    return this.activePages.size;
  }

  public get idlePageCount(): number {
    return this.idlePages.length;
  }

  public get waitingLeaseCount(): number {
    return this.waiters.length;
  }

  public async lease(signal?: AbortSignal): Promise<PageLease> {
    if (this.closed) {
      throw new PagePoolClosedError();
    }
    if (signal?.aborted === true) {
      throw new PageLeaseAbortedError();
    }

    const idle = this.takeIdlePage();
    if (idle !== null) {
      return this.activate(idle);
    }

    if (this.pages.size + this.creatingPages < this.maxPages) {
      return this.createLease(signal);
    }

    return new Promise<PageLease>((resolve, reject) => {
      const waiter: LeaseWaiter = {
        resolve,
        reject,
        signal,
        abortListener: signal === undefined
          ? undefined
          : () => {
              const index = this.waiters.indexOf(waiter);
              if (index >= 0) {
                this.waiters.splice(index, 1);
              }
              reject(new PageLeaseAbortedError());
            },
      };
      if (waiter.abortListener !== undefined) {
        signal?.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    for (const waiter of this.waiters.splice(0)) {
      this.removeAbortListener(waiter);
      waiter.reject(new PagePoolClosedError());
    }
    for (const idle of this.idlePages.splice(0)) {
      clearTimeout(idle.timer);
    }

    const pages = [...this.pages];
    this.pages.clear();
    this.activePages.clear();
    await Promise.all(
      pages.map((page) => page.close({ runBeforeUnload: false }).catch(() => undefined)),
    );
  }

  private async createLease(signal?: AbortSignal): Promise<PageLease> {
    this.creatingPages += 1;
    try {
      const page = await this.context.newPage();
      if (this.closed) {
        await page.close().catch(() => undefined);
        throw new PagePoolClosedError();
      }
      if (signal?.aborted === true) {
        await page.close().catch(() => undefined);
        throw new PageLeaseAbortedError();
      }

      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      page.setDefaultTimeout(this.navigationTimeoutMs);
      this.pages.add(page);
      page.once("close", () => this.handlePageClosed(page));
      page.once("crash", () => {
        void page.close().catch(() => undefined);
      });
      return this.activate(page);
    } finally {
      this.creatingPages -= 1;
      this.drainWaiters();
    }
  }

  private activate(page: Page): PageLease {
    this.activePages.add(page);
    let released = false;
    return {
      page,
      release: async (options = {}) => {
        if (released) {
          return;
        }
        released = true;
        await this.releasePage(page, options.discard ?? false);
      },
    };
  }

  private async releasePage(page: Page, discard: boolean): Promise<void> {
    if (!this.activePages.delete(page)) {
      return;
    }

    if (this.closed || discard || page.isClosed()) {
      this.pages.delete(page);
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      this.drainWaiters();
      return;
    }

    const reusable = await this.resetPage(page);
    if (!reusable) {
      this.pages.delete(page);
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
      this.drainWaiters();
      return;
    }

    const waiter = this.takeWaiter();
    if (waiter !== null) {
      waiter.resolve(this.activate(page));
      return;
    }
    this.storeIdlePage(page);
  }

  private storeIdlePage(page: Page): void {
    const timer = setTimeout(() => {
      const index = this.idlePages.findIndex((entry) => entry.page === page);
      if (index >= 0) {
        this.idlePages.splice(index, 1);
      }
      this.pages.delete(page);
      void page.close({ runBeforeUnload: false }).catch(() => undefined);
    }, this.idleTimeoutMs);
    timer.unref();
    this.idlePages.push({ page, timer });
  }

  private async resetPage(page: Page): Promise<boolean> {
    try {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.goto("about:blank", {
        waitUntil: "commit",
        timeout: this.navigationTimeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  private takeIdlePage(): Page | null {
    while (this.idlePages.length > 0) {
      const idle = this.idlePages.shift();
      if (idle === undefined) {
        return null;
      }
      clearTimeout(idle.timer);
      if (!idle.page.isClosed()) {
        return idle.page;
      }
      this.pages.delete(idle.page);
    }
    return null;
  }

  private takeWaiter(): LeaseWaiter | null {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        return null;
      }
      this.removeAbortListener(waiter);
      if (waiter.signal?.aborted !== true) {
        return waiter;
      }
    }
    return null;
  }

  private removeAbortListener(waiter: LeaseWaiter): void {
    if (waiter.abortListener !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.abortListener);
    }
  }

  private handlePageClosed(page: Page): void {
    this.pages.delete(page);
    this.activePages.delete(page);
    const idleIndex = this.idlePages.findIndex((entry) => entry.page === page);
    if (idleIndex >= 0) {
      const [idle] = this.idlePages.splice(idleIndex, 1);
      if (idle !== undefined) {
        clearTimeout(idle.timer);
      }
    }
    this.drainWaiters();
  }

  private drainWaiters(): void {
    if (this.closed) {
      return;
    }

    while (this.waiters.length > 0) {
      const idle = this.takeIdlePage();
      if (idle !== null) {
        const waiter = this.takeWaiter();
        if (waiter !== null) {
          waiter.resolve(this.activate(idle));
          continue;
        }
        this.storeIdlePage(idle);
        return;
      }

      if (this.pages.size + this.creatingPages >= this.maxPages) {
        return;
      }
      const waiter = this.takeWaiter();
      if (waiter === null) {
        return;
      }
      void this.createLease(waiter.signal).then(waiter.resolve, waiter.reject);
    }
  }
}
