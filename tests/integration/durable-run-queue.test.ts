import { afterEach, describe, expect, it } from "vitest";

import { openPersistence, type Persistence } from "../../src/db/index.js";
import {
  DurableRunQueue,
  QueueFullError,
  type RunExecutionContext,
  type RunExecutionResult,
  type RunDispatchGate,
  type RunExecutor,
} from "../../src/scheduler/index.js";
import type { RunRecord } from "../../src/domain/index.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function createDeferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class ControlledExecutor implements RunExecutor {
  public readonly started: string[] = [];
  public activeCount = 0;
  public maxActiveCount = 0;
  private readonly gates = new Map<string, Deferred>();

  public addGate(runId: string): Deferred {
    const gate = createDeferred();
    this.gates.set(runId, gate);
    return gate;
  }

  public async execute(
    run: RunRecord,
    context: RunExecutionContext,
  ): Promise<RunExecutionResult> {
    context.updateProgress({
      state: "running",
      phase: "fake_execution",
      submissionState: "confirmed",
    });
    this.started.push(run.id);
    this.activeCount += 1;
    this.maxActiveCount = Math.max(this.maxActiveCount, this.activeCount);
    try {
      const gate = this.gates.get(run.id);
      if (gate !== undefined) {
        await gate.promise;
      }
      return { outcome: "succeeded", finalResponse: `response:${run.id}` };
    } finally {
      this.activeCount -= 1;
    }
  }
}

const openPersistenceInstances: Persistence[] = [];
const openQueues: DurableRunQueue[] = [];

function createPersistence(): Persistence {
  const persistence = openPersistence(":memory:");
  openPersistenceInstances.push(persistence);
  return persistence;
}

function createQueue(
  persistence: Persistence,
  executor: RunExecutor,
  maxConcurrentRuns = 2,
  maxQueueDepth = 20,
  dispatchGate?: RunDispatchGate,
): DurableRunQueue {
  const queue = new DurableRunQueue({
    persistence,
    executor,
    maxConcurrentRuns,
    maxQueueDepth,
    ...(dispatchGate === undefined ? {} : { dispatchGate }),
  });
  openQueues.push(queue);
  return queue;
}

afterEach(async () => {
  while (openQueues.length > 0) {
    await openQueues.pop()?.close();
  }
  while (openPersistenceInstances.length > 0) {
    openPersistenceInstances.pop()?.close();
  }
});

describe("durable run queue", () => {
  it("stops dispatching queued runs while allowing active work to drain", async () => {
    const persistence = createPersistence();
    const firstThread = persistence.threads.create({
      name: "Shutdown active",
      state: "idle",
    });
    const secondThread = persistence.threads.create({
      name: "Shutdown queued",
      state: "idle",
    });
    const executor = new ControlledExecutor();
    const activeGate = executor.addGate("shutdown-active");
    const queue = createQueue(persistence, executor, 1);
    queue.start();
    queue.enqueue({
      id: "shutdown-active",
      threadId: firstThread.id,
      operationType: "send_message",
      inputText: "Finish during shutdown.",
    });
    queue.enqueue({
      id: "shutdown-queued",
      threadId: secondThread.id,
      operationType: "send_message",
      inputText: "Remain durable for restart.",
    });

    await waitUntil(() => executor.started.includes("shutdown-active"));
    const firstClose = queue.close();
    const secondClose = queue.close();
    expect(secondClose).toBe(firstClose);
    expect(queue.getSnapshot()).toMatchObject({
      state: "stopping",
      activeRunCount: 1,
      queuedRunCount: 1,
      dispatchEnabled: false,
    });

    activeGate.resolve();
    await firstClose;
    expect(executor.started).toEqual(["shutdown-active"]);
    expect(persistence.runs.getRequiredById("shutdown-active").state).toBe(
      "succeeded",
    );
    expect(persistence.runs.getRequiredById("shutdown-queued").state).toBe(
      "queued",
    );
    expect(queue.getSnapshot()).toMatchObject({
      state: "stopped",
      activeRunCount: 0,
      queuedRunCount: 1,
      dispatchEnabled: false,
    });
  });

  it("executes different threads concurrently", async () => {
    const persistence = createPersistence();
    const firstThread = persistence.threads.create({
      name: "First",
      state: "idle",
    });
    const secondThread = persistence.threads.create({
      name: "Second",
      state: "idle",
    });
    const executor = new ControlledExecutor();
    const firstGate = executor.addGate("run-first");
    const secondGate = executor.addGate("run-second");
    const queue = createQueue(persistence, executor, 2);
    queue.start();

    queue.enqueue({
      id: "run-first",
      threadId: firstThread.id,
      operationType: "send_message",
      inputText: "First prompt",
    });
    queue.enqueue({
      id: "run-second",
      threadId: secondThread.id,
      operationType: "send_message",
      inputText: "Second prompt",
    });

    await waitUntil(() => executor.started.length === 2);
    expect(executor.maxActiveCount).toBe(2);

    firstGate.resolve();
    secondGate.resolve();
    await queue.waitForIdle();
    expect(persistence.runs.getRequiredById("run-first").state).toBe(
      "succeeded",
    );
    expect(persistence.runs.getRequiredById("run-second").state).toBe(
      "succeeded",
    );
  });

  it("serializes operations on the same thread", async () => {
    const persistence = createPersistence();
    const thread = persistence.threads.create({
      name: "Serialized",
      state: "idle",
    });
    const executor = new ControlledExecutor();
    const firstGate = executor.addGate("run-one");
    const secondGate = executor.addGate("run-two");
    const queue = createQueue(persistence, executor, 2);
    queue.start();

    queue.enqueue({
      id: "run-one",
      threadId: thread.id,
      operationType: "send_message",
      inputText: "One",
    });
    queue.enqueue({
      id: "run-two",
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Two",
    });

    await waitUntil(() => executor.started.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executor.started).toEqual(["run-one"]);
    expect(executor.maxActiveCount).toBe(1);

    firstGate.resolve();
    await waitUntil(() => executor.started.length === 2);
    expect(executor.started).toEqual(["run-one", "run-two"]);
    secondGate.resolve();
    await queue.waitForIdle();
  });

  it("executes queued database work after process startup", async () => {
    const persistence = createPersistence();
    const thread = persistence.threads.create({ name: "Durable", state: "idle" });
    persistence.runs.createOrGet({
      id: "queued-before-start",
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Persisted prompt",
    });

    const executor = new ControlledExecutor();
    const queue = createQueue(persistence, executor);
    queue.start();
    await queue.waitForIdle();

    expect(executor.started).toEqual(["queued-before-start"]);
    expect(persistence.runs.getRequiredById("queued-before-start").state).toBe(
      "succeeded",
    );
  });

  it("classifies interrupted and ambiguous runs on restart", async () => {
    const persistence = createPersistence();
    const safeThread = persistence.threads.create({ name: "Safe restart" });
    const ambiguousThread = persistence.threads.create({
      name: "Ambiguous restart",
      state: "running",
    });

    const safeRun = persistence.runs.createOrGet({
      id: "safe-run",
      threadId: safeThread.id,
      operationType: "create_thread",
      inputText: "Not submitted",
    }).run;
    persistence.runs.claimQueued(safeRun.id);
    persistence.runs.transition(safeRun.id, {
      state: "running",
      phase: "before_submission",
      submissionState: "not_started",
    });

    const ambiguousRun = persistence.runs.createOrGet({
      id: "ambiguous-run",
      threadId: ambiguousThread.id,
      operationType: "send_message",
      inputText: "Possibly submitted",
    }).run;
    persistence.runs.claimQueued(ambiguousRun.id);
    persistence.runs.transition(ambiguousRun.id, {
      state: "submitting",
      phase: "submit_clicked",
      submissionState: "submitted_unconfirmed",
    });

    const executor: RunExecutor = {
      execute: () => {
        throw new Error("Reconciled runs must not execute automatically");
      },
    };
    const queue = createQueue(persistence, executor);
    const reconciled = queue.start();

    expect(reconciled).toHaveLength(2);
    expect(reconciled).toEqual(
      expect.arrayContaining([
        {
          runId: "safe-run",
          previousState: "running",
          reconciledState: "interrupted",
        },
        {
          runId: "ambiguous-run",
          previousState: "submitting",
          reconciledState: "needs_attention",
        },
      ]),
    );
    expect(persistence.runs.getRequiredById("safe-run").state).toBe(
      "interrupted",
    );
    expect(persistence.threads.getRequiredById(safeThread.id).state).toBe(
      "error",
    );
    expect(persistence.runs.getRequiredById("ambiguous-run").state).toBe(
      "needs_attention",
    );
    expect(
      persistence.threads.getRequiredById(ambiguousThread.id).state,
    ).toBe("needs_attention");
    await queue.waitForIdle();
  });

  it("rechecks mapped needs-attention runs and skips deleted threads", async () => {
    const persistence = createPersistence();
    const recoverableThread = persistence.threads.create({
      name: "Recoverable attention",
      state: "running",
    });
    persistence.threads.setRemoteMapping(recoverableThread.id, {
      conversationId: "recoverable-conversation",
      url: "https://chatgpt.example/c/recoverable-conversation",
      title: null,
    });
    const recoverableRun = persistence.runs.createOrGet({
      id: "recoverable-attention-run",
      threadId: recoverableThread.id,
      operationType: "create_thread",
      inputText: "Persisted recovery prompt",
    }).run;
    persistence.runs.claimQueued(recoverableRun.id);
    persistence.runs.transition(recoverableRun.id, {
      state: "submitting",
      phase: "creating_conversation",
      submissionState: "typed",
    });
    persistence.runs.transition(recoverableRun.id, {
      state: "needs_attention",
      phase: "needs_attention",
      errorCode: "submission_ambiguous",
      errorMessage: "Inspect the mapped conversation",
    });
    persistence.threads.setState(
      recoverableThread.id,
      "needs_attention",
      "submission_ambiguous",
      "Inspect the mapped conversation",
    );

    const deletedThread = persistence.threads.create({
      name: "Deleted recovery",
      state: "running",
    });
    persistence.threads.setRemoteMapping(deletedThread.id, {
      conversationId: "deleted-conversation",
      url: "https://chatgpt.example/c/deleted-conversation",
      title: null,
    });
    const deletedRun = persistence.runs.createOrGet({
      id: "deleted-active-run",
      threadId: deletedThread.id,
      operationType: "create_thread",
      inputText: "Do not recover this",
    }).run;
    persistence.runs.claimQueued(deletedRun.id);
    persistence.runs.transition(deletedRun.id, {
      state: "running",
      phase: "waiting_for_response",
      submissionState: "confirmed",
    });
    persistence.threads.setState(deletedThread.id, "deleted_local");

    const executor = new ControlledExecutor();
    const queue = createQueue(persistence, executor);
    queue.start();
    await queue.waitForIdle();

    expect(executor.started).toEqual(["recoverable-attention-run"]);
    expect(
      persistence.runs.getRequiredById("recoverable-attention-run").state,
    ).toBe("succeeded");
    expect(persistence.runs.getRequiredById("deleted-active-run").state).toBe(
      "cancelled",
    );
    expect(persistence.threads.getRequiredById(deletedThread.id).state).toBe(
      "deleted_local",
    );
  });

  it("enforces queue depth without rejecting an idempotent retry", () => {
    const persistence = createPersistence();
    const firstThread = persistence.threads.create({ name: "Queue one" });
    const secondThread = persistence.threads.create({ name: "Queue two" });
    const executor = new ControlledExecutor();
    const queue = createQueue(persistence, executor, 1, 1);

    const first = queue.enqueue({
      id: "queued-one",
      threadId: firstThread.id,
      operationType: "send_message",
      inputText: "One",
      idempotencyKey: "same-request",
    });
    const retried = queue.enqueue({
      threadId: firstThread.id,
      operationType: "send_message",
      inputText: "One",
      idempotencyKey: "same-request",
    });
    expect(retried).toEqual({ run: first.run, created: false });

    expect(() =>
      queue.enqueue({
        threadId: secondThread.id,
        operationType: "send_message",
        inputText: "Two",
      }),
    ).toThrow(QueueFullError);
  });

  it("records unexpected executor failures durably", async () => {
    const persistence = createPersistence();
    const thread = persistence.threads.create({ name: "Failure" });
    const executor: RunExecutor = {
      execute: () => Promise.reject(new Error("Synthetic executor failure")),
    };
    const queue = createQueue(persistence, executor);
    queue.start();
    queue.enqueue({
      id: "failed-run",
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Fail",
    });
    await queue.waitForIdle();

    const run = persistence.runs.getRequiredById("failed-run");
    expect(run.state).toBe("failed");
    expect(run.errorCode).toBe("unexpected_state");
    expect(run.errorMessage).toBe("Synthetic executor failure");
  });

  it("keeps work queued while the browser gate is closed and resumes once", async () => {
    const persistence = createPersistence();
    const thread = persistence.threads.create({
      name: "Authentication gate",
      state: "idle",
    });
    const executor = new ControlledExecutor();
    const listeners = new Set<() => void>();
    let ready = false;
    const dispatchGate: RunDispatchGate = {
      canDispatch: () => ready,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const queue = createQueue(persistence, executor, 1, 20, dispatchGate);
    queue.start();
    queue.enqueue({
      id: "auth-gated-run",
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Do not submit until login is ready.",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(executor.started).toEqual([]);
    expect(persistence.runs.getRequiredById("auth-gated-run").state).toBe(
      "queued",
    );

    ready = true;
    for (const listener of listeners) {
      listener();
    }
    await queue.waitForIdle();

    expect(executor.started).toEqual(["auth-gated-run"]);
    expect(persistence.runs.getRequiredById("auth-gated-run").state).toBe(
      "succeeded",
    );
  });

  it("releases an untouched claim when the browser gate closes mid-dispatch", async () => {
    const persistence = createPersistence();
    const thread = persistence.threads.create({
      name: "Dispatch race",
      state: "idle",
    });
    const executor = new ControlledExecutor();
    const listeners = new Set<() => void>();
    let ready = false;
    let dispatchChecks = 0;
    const dispatchGate: RunDispatchGate = {
      canDispatch: () => {
        dispatchChecks += 1;
        return ready || dispatchChecks <= 2;
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const queue = createQueue(persistence, executor, 1, 20, dispatchGate);
    queue.start();
    queue.enqueue({
      id: "race-gated-run",
      threadId: thread.id,
      operationType: "send_message",
      inputText: "Remain queued until the gate reopens.",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const paused = persistence.runs.getRequiredById("race-gated-run");
    expect(paused.state).toBe("queued");
    expect(paused.submissionState).toBe("not_started");
    expect(paused.startedAt).toBeNull();
    expect(executor.started).toEqual([]);

    ready = true;
    for (const listener of listeners) {
      listener();
    }
    await queue.waitForIdle();
    expect(executor.started).toEqual(["race-gated-run"]);
  });
});
