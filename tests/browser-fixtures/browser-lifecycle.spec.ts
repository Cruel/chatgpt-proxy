import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { chromium, type BrowserContext } from "playwright";

import {
  BrowserManager,
  BrowserOperationBlockedError,
  type PersistentContextLauncher,
} from "../../src/browser/index.js";
import {
  startBrowserFixtureServer,
  type BrowserFixtureServer,
} from "./fixture-server.js";

interface TestResources {
  readonly directory: string;
  readonly server: BrowserFixtureServer;
  readonly managers: BrowserManager[];
}

async function createResources(): Promise<TestResources> {
  return {
    directory: await mkdtemp(join(tmpdir(), "chatgpt-proxy-browser-")),
    server: await startBrowserFixtureServer(),
    managers: [],
  };
}

async function disposeResources(resources: TestResources): Promise<void> {
  await Promise.all(resources.managers.map((manager) => manager.close()));
  await resources.server.close();
  await rm(resources.directory, { recursive: true, force: true });
}

function createManager(
  resources: TestResources,
  startupPath: string,
  options: {
    readonly profileName?: string;
    readonly maxConcurrentPages?: number;
    readonly idleTimeoutMs?: number;
    readonly launcher?: PersistentContextLauncher;
  } = {},
): BrowserManager {
  const manager = new BrowserManager({
    profileDirectory: join(
      resources.directory,
      options.profileName ?? "profile",
    ),
    startupUrl: `${resources.server.baseUrl}${startupPath}`,
    headless: true,
    maxConcurrentPages: options.maxConcurrentPages ?? 2,
    pageIdleTimeoutMs: options.idleTimeoutMs ?? 100,
    navigationTimeoutMs: 5_000,
    statusPollIntervalMs: 25,
    recoveryDelaysMs: [0, 25, 50],
    ...(options.launcher === undefined
      ? {}
      : { launchPersistentContext: options.launcher }),
  });
  resources.managers.push(manager);
  return manager;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for browser fixture condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("authentication states are detected from local fixtures", async () => {
  const resources = await createResources();
  try {
    const manager = createManager(resources, "/logged-out");
    await expect(manager.start()).resolves.toMatchObject({
      status: "auth_required",
    });

    const leaseError = await manager.leasePage().catch((error: unknown) => error);
    expect(leaseError).toBeInstanceOf(BrowserOperationBlockedError);
    expect(manager.getStatus().activePageCount).toBe(0);

    const verificationManager = createManager(resources, "/verification", {
      profileName: "verification-profile",
    });
    await verificationManager.start();
    expect(verificationManager.currentStatus).toBe("verification_required");
  } finally {
    await disposeResources(resources);
  }
});

test("startup waits through transient client hydration", async () => {
  const resources = await createResources();
  try {
    const manager = createManager(resources, "/hydrating");
    await expect(manager.start()).resolves.toMatchObject({ status: "ready" });
  } finally {
    await disposeResources(resources);
  }
});

test("manual login readiness opens the operation gate without consuming a run page", async () => {
  const resources = await createResources();
  try {
    const manager = createManager(resources, "/session");
    await manager.start();
    expect(manager.operationGate.canDispatch()).toBe(false);
    expect(manager.getStatus().activePageCount).toBe(0);
    await manager.showManualLoginPage();

    resources.server.setSessionState("ready");
    await manager.waitForReady({ timeoutMs: 5_000 });
    expect(manager.operationGate.canDispatch()).toBe(true);

    const lease = await manager.leasePage();
    expect(manager.getStatus().activePageCount).toBe(1);
    await lease.release();
    expect(manager.getStatus().activePageCount).toBe(0);
  } finally {
    await disposeResources(resources);
  }
});

test("logout detected in an operation tab keeps the global gate closed", async () => {
  const resources = await createResources();
  try {
    resources.server.setSessionState("ready");
    const manager = createManager(resources, "/session");
    await manager.start();
    expect(manager.currentStatus).toBe("ready");

    const lease = await manager.leasePage();
    resources.server.setSessionState("auth_required");
    await lease.page.goto(`${resources.server.baseUrl}/logged-out`);
    await manager.reportPageStatus(lease.page);
    expect(manager.currentStatus).toBe("auth_required");

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(manager.currentStatus).toBe("auth_required");
    expect(manager.operationGate.canDispatch()).toBe(false);

    resources.server.setSessionState("ready");
    await manager.waitForReady({ timeoutMs: 5_000 });
    expect(manager.operationGate.canDispatch()).toBe(true);
    await lease.release();
  } finally {
    await disposeResources(resources);
  }
});

test("the page pool leases concurrent tabs and reuses released capacity", async () => {
  const resources = await createResources();
  try {
    const manager = createManager(resources, "/conversation", {
      maxConcurrentPages: 2,
    });
    await manager.start();

    const first = await manager.leasePage();
    const second = await manager.leasePage();
    expect(first.page).not.toBe(second.page);
    expect(manager.getStatus().activePageCount).toBe(2);

    let thirdResolved = false;
    const thirdPromise = manager.leasePage().then((lease) => {
      thirdResolved = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(thirdResolved).toBe(false);

    await first.release();
    const third = await thirdPromise;
    expect(third.page).toBe(first.page);
    expect(manager.getStatus().activePageCount).toBe(2);

    await second.release();
    await third.release();
  } finally {
    await disposeResources(resources);
  }
});

test("persistent profile storage survives a browser manager restart", async () => {
  const resources = await createResources();
  try {
    const firstManager = createManager(resources, "/storage", {
      profileName: "persistent-profile",
    });
    await firstManager.start();
    const firstLease = await firstManager.leasePage();
    await firstLease.page.goto(`${resources.server.baseUrl}/storage`);
    await firstLease.page.evaluate(() => {
      localStorage.setItem("fixture-login-token", "retained");
    });
    await firstLease.release();
    await firstManager.close();

    const secondManager = createManager(resources, "/storage", {
      profileName: "persistent-profile",
    });
    await secondManager.start();
    const secondLease = await secondManager.leasePage();
    await secondLease.page.goto(`${resources.server.baseUrl}/storage`);
    const retained = await secondLease.page.evaluate(() =>
      localStorage.getItem("fixture-login-token"),
    );
    expect(retained).toBe("retained");
    await secondLease.release();
  } finally {
    await disposeResources(resources);
  }
});

test("an unexpected persistent context close is recovered automatically", async () => {
  const resources = await createResources();
  try {
    const contexts: BrowserContext[] = [];
    const launcher: PersistentContextLauncher = async (
      profileDirectory,
      options,
    ) => {
      const context = await chromium.launchPersistentContext(
        profileDirectory,
        options,
      );
      contexts.push(context);
      return context;
    };
    const manager = createManager(resources, "/conversation", { launcher });
    await manager.start();
    expect(contexts).toHaveLength(1);

    await contexts[0]?.close();
    await waitUntil(() => contexts.length >= 2);
    await manager.waitForReady({ timeoutMs: 5_000 });
    expect(manager.currentStatus).toBe("ready");

    const lease = await manager.leasePage();
    await lease.page.goto(`${resources.server.baseUrl}/conversation`);
    expect(await lease.page.title()).toBe("Conversation");
    await lease.release();
  } finally {
    await disposeResources(resources);
  }
});
