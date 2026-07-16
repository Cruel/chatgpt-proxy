import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  InvalidRunTransitionError,
  ThreadNameConflictError,
  getLatestMigrationVersion,
  openPersistence,
  type Persistence,
} from "../../src/db/index.js";

interface TestDatabase {
  readonly directory: string;
  readonly path: string;
  readonly persistence: Persistence;
}

const openDatabases: TestDatabase[] = [];

async function createTestDatabase(): Promise<TestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "chatgpt-proxy-db-"));
  const path = join(directory, "state.sqlite3");
  const persistence = openPersistence(path);
  const opened = { directory, path, persistence };
  openDatabases.push(opened);
  return opened;
}

afterEach(async () => {
  while (openDatabases.length > 0) {
    const opened = openDatabases.pop();
    opened?.persistence.close();
    if (opened !== undefined) {
      await rm(opened.directory, { recursive: true, force: true });
    }
  }
});

describe("SQLite persistence", () => {
  it("applies migrations and required SQLite settings idempotently", async () => {
    const opened = await createTestDatabase();

    expect(
      opened.persistence.database.pragma("journal_mode", { simple: true }),
    ).toBe("wal");
    expect(
      opened.persistence.database.pragma("foreign_keys", { simple: true }),
    ).toBe(1);
    expect(
      opened.persistence.database.pragma("busy_timeout", { simple: true }),
    ).toBe(5000);
    expect(statSync(opened.path).mode & 0o777).toBe(0o600);

    const migration = opened.persistence.database
      .prepare<[], { version: number }>(`
        SELECT version FROM schema_migrations
      `)
      .get();
    expect(migration?.version).toBe(getLatestMigrationVersion());

    opened.persistence.close();
    const reopened = openPersistence(opened.path);
    openDatabases[0] = { ...opened, persistence: reopened };
    const migrationCount = reopened.database
      .prepare<[], { count: number }>(`
        SELECT COUNT(*) AS count FROM schema_migrations
      `)
      .get();
    expect(migrationCount?.count).toBe(1);
  });

  it("persists threads, runs, events, artifacts, and remote mappings", async () => {
    const { persistence } = await createTestDatabase();
    const thread = persistence.threads.create({ name: "Architecture Review" });

    expect(thread.normalizedName).toBe("architecture review");
    expect(() =>
      persistence.threads.create({ name: "  ARCHITECTURE   REVIEW " }),
    ).toThrow(ThreadNameConflictError);

    const mappedThread = persistence.threads.setRemoteMapping(thread.id, {
      conversationId: "conversation-1",
      url: "https://chatgpt.com/c/conversation-1",
      title: "Observed title",
    });
    expect(mappedThread.remoteConversationId).toBe("conversation-1");

    const created = persistence.runs.createOrGet({
      id: "run-1",
      threadId: thread.id,
      operationType: "create_thread",
      inputText: "Review the architecture.",
      idempotencyKey: "request-1",
    });
    expect(created.created).toBe(true);
    expect(created.run.inputSha256).toMatch(/^[a-f\d]{64}$/);

    const retried = persistence.runs.createOrGet({
      threadId: thread.id,
      operationType: "create_thread",
      inputText: "Review the architecture.",
      idempotencyKey: "request-1",
    });
    expect(retried).toEqual({ run: created.run, created: false });

    expect(() =>
      persistence.runs.createOrGet({
        threadId: thread.id,
        operationType: "create_thread",
        inputText: "Use a different prompt.",
        idempotencyKey: "request-1",
      }),
    ).toThrow(IdempotencyConflictError);

    const sameKeyDifferentOperation = persistence.runs.createOrGet({
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Continue.",
      idempotencyKey: "request-1",
    });
    expect(sameKeyDifferentOperation.created).toBe(true);

    const event = persistence.runEvents.append(created.run.id, "selector_seen", {
      selector: "assistant-turn",
    });
    expect(event.payload).toEqual({ selector: "assistant-turn" });

    const artifact = persistence.artifacts.create({
      id: "artifact-1",
      runId: created.run.id,
      artifactType: "html",
      path: "/tmp/run-1.html",
      sha256: "a".repeat(64),
      sizeBytes: 123,
    });
    expect(artifact.sha256).toBe("a".repeat(64));
    expect(persistence.artifacts.listByRun(created.run.id)).toEqual([artifact]);

    const deleted = persistence.threads.setState(thread.id, "deleted_remote");
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.remoteDeletedAt).not.toBeNull();
  });

  it("enforces explicit run-state transitions", async () => {
    const { persistence } = await createTestDatabase();
    const thread = persistence.threads.create({ name: "Transition Test" });
    const run = persistence.runs.createOrGet({
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Test transitions.",
    }).run;

    const claimed = persistence.runs.claimQueued(run.id);
    expect(claimed?.state).toBe("navigating");
    persistence.runs.transition(run.id, {
      state: "running",
      phase: "waiting_for_response",
      submissionState: "confirmed",
    });
    const succeeded = persistence.runs.transition(run.id, {
      state: "succeeded",
      phase: "completed",
      finalResponse: "Done.",
    });
    expect(succeeded.completedAt).not.toBeNull();
    expect(succeeded.finalResponse).toBe("Done.");

    expect(() =>
      persistence.runs.transition(run.id, {
        state: "running",
        phase: "invalid",
      }),
    ).toThrow(InvalidRunTransitionError);

    const retryThread = persistence.threads.create({ name: "Retry Test" });
    const retryRun = persistence.runs.createOrGet({
      threadId: retryThread.id,
      operationType: "send_message",
      inputText: "Retry safely.",
    }).run;
    persistence.runs.claimQueued(retryRun.id);
    persistence.runs.transition(retryRun.id, {
      state: "running",
      phase: "submitted",
      submissionState: "confirmed",
    });
    persistence.runs.transition(retryRun.id, {
      state: "interrupted",
      phase: "interrupted",
    });
    const requeued = persistence.runs.transition(retryRun.id, {
      state: "queued",
      phase: "queued",
    });
    expect(requeued.submissionState).toBe("not_started");
    expect(requeued.startedAt).toBeNull();
    expect(requeued.completedAt).toBeNull();
  });
});
