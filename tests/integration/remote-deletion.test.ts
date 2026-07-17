import { afterEach, describe, expect, it } from "vitest";

import {
  apiErrorResponseSchema,
  mutationAcceptedResponseSchema,
  runStatusResponseSchema,
  threadDetailResponseSchema,
} from "../../src/api/schemas.js";
import type { TestRuntime } from "../helpers/test-runtime.js";
import {
  authenticatedHeaders,
  createTestRuntime,
} from "../helpers/test-runtime.js";

const openRuntimes: TestRuntime[] = [];

function runtime(): TestRuntime {
  const testRuntime = createTestRuntime(true);
  openRuntimes.push(testRuntime);
  return testRuntime;
}

afterEach(async () => {
  while (openRuntimes.length > 0) {
    await openRuntimes.pop()?.close();
  }
});

async function create(testRuntime: TestRuntime, name: string): Promise<void> {
  const response = await testRuntime.runtime.app.inject({
    method: "POST",
    url: "/v1/threads",
    headers: authenticatedHeaders({ "idempotency-key": `create-${name}` }),
    payload: { name, message: "Create remote thread.", wait: true },
  });
  expect(response.statusCode).toBe(201);
}

async function remoteDelete(testRuntime: TestRuntime, name: string) {
  return testRuntime.runtime.app.inject({
    method: "DELETE",
    url: `/v1/threads/${name}`,
    headers: authenticatedHeaders({ "idempotency-key": `delete-${name}` }),
    payload: { delete_remote: true, wait: true },
  });
}

describe("remote deletion outcomes", () => {
  it("rolls back the local tombstone when its audit event cannot commit", async () => {
    const testRuntime = runtime();
    await create(testRuntime, "atomic-local-delete");
    testRuntime.persistence.database.exec(`
      CREATE TRIGGER fail_local_tombstone_event
      BEFORE INSERT ON run_events
      WHEN NEW.event_type = 'local_thread_tombstoned'
      BEGIN
        SELECT RAISE(ABORT, 'forced tombstone audit failure');
      END;
    `);

    const response = await testRuntime.runtime.app.inject({
      method: "DELETE",
      url: "/v1/threads/atomic-local-delete",
      headers: authenticatedHeaders({
        "idempotency-key": "delete-atomic-local-delete",
      }),
      payload: { delete_remote: false, wait: true },
    });
    expect(response.statusCode).toBe(502);
    const error = apiErrorResponseSchema.parse(response.json()).error;
    expect(error.code).toBe("unexpected_state");
    const runId = String(error.details?.runId);

    const infoResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads/atomic-local-delete",
      headers: authenticatedHeaders(),
    });
    const info = threadDetailResponseSchema.parse(infoResponse.json());
    expect(info.thread.state).toBe("delete_failed");
    expect(info.thread.deletedAt).toBeNull();
    expect(info.thread.remoteConversationId).not.toBeNull();
    expect(
      testRuntime.persistence.runEvents
        .listByRun(runId)
        .some((event) => event.eventType === "local_thread_tombstoned"),
    ).toBe(false);
  });

  it("confirms deletion before tombstoning locally", async () => {
    const testRuntime = runtime();
    await create(testRuntime, "remote-success");

    const response = await remoteDelete(testRuntime, "remote-success");
    expect(response.statusCode).toBe(200);
    const deleted = mutationAcceptedResponseSchema.parse(response.json());
    expect(deleted.thread.state).toBe("deleted_remote");
    expect(testRuntime.adapter.deleteCalls).toHaveLength(1);

    const status = await testRuntime.runtime.app.inject({
      method: "GET",
      url: `/v1/runs/${deleted.run.id}`,
      headers: authenticatedHeaders(),
    });
    expect(runStatusResponseSchema.parse(status.json()).deletion).toEqual({
      remoteRequested: true,
      remotePermitted: true,
      remoteOutcome: "deleted",
      localTombstoned: true,
    });

    const retried = await remoteDelete(testRuntime, "remote-success");
    expect(retried.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(retried.json()).error.code).toBe(
      "thread_not_found",
    );
    expect(testRuntime.adapter.deleteCalls).toHaveLength(1);
  });

  it("treats an already absent remote conversation as success", async () => {
    const testRuntime = runtime();
    await create(testRuntime, "remote-absent");
    testRuntime.adapter.enqueueDeleteResult({
      ok: true,
      value: { outcome: "already_absent", evidence: ["missing"] },
    });

    const response = await remoteDelete(testRuntime, "remote-absent");
    expect(response.statusCode).toBe(200);
    const deleted = mutationAcceptedResponseSchema.parse(response.json());
    expect(deleted.thread.state).toBe("deleted_remote");
    const status = await testRuntime.runtime.app.inject({
      method: "GET",
      url: `/v1/runs/${deleted.run.id}`,
      headers: authenticatedHeaders(),
    });
    expect(
      runStatusResponseSchema.parse(status.json()).deletion?.remoteOutcome,
    ).toBe("already_absent");
  });

  it("preserves the mapping when remote deletion fails", async () => {
    const testRuntime = runtime();
    await create(testRuntime, "remote-failure");
    testRuntime.adapter.enqueueDeleteResult({
      ok: false,
      error: {
        code: "remote_delete_failed",
        message: "Synthetic remote deletion failure",
        retryable: true,
        observedUrl: null,
      },
    });

    const response = await remoteDelete(testRuntime, "remote-failure");
    expect(response.statusCode).toBe(502);
    const error = apiErrorResponseSchema.parse(response.json()).error;
    expect(error.code).toBe("remote_delete_failed");
    const runId = String(error.details?.runId);

    const infoResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads/remote-failure",
      headers: authenticatedHeaders(),
    });
    const info = threadDetailResponseSchema.parse(infoResponse.json());
    expect(info.thread.state).toBe("delete_failed");
    expect(info.thread.remoteConversationId).not.toBeNull();
    expect(info.thread.deletedAt).toBeNull();

    const status = await testRuntime.runtime.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: authenticatedHeaders(),
    });
    expect(runStatusResponseSchema.parse(status.json()).deletion).toEqual({
      remoteRequested: true,
      remotePermitted: true,
      remoteOutcome: null,
      localTombstoned: false,
    });
  });

  it("marks ambiguous deletion for attention without tombstoning", async () => {
    const testRuntime = runtime();
    await create(testRuntime, "remote-ambiguous");
    testRuntime.adapter.enqueueDeleteResult({
      ok: true,
      value: { outcome: "ambiguous", evidence: ["dialog disappeared"] },
    });

    const response = await remoteDelete(testRuntime, "remote-ambiguous");
    expect(response.statusCode).toBe(409);
    const error = apiErrorResponseSchema.parse(response.json()).error;
    expect(error.code).toBe("remote_delete_ambiguous");
    const runId = String(error.details?.runId);

    const infoResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads/remote-ambiguous",
      headers: authenticatedHeaders(),
    });
    const info = threadDetailResponseSchema.parse(infoResponse.json());
    expect(info.thread.state).toBe("needs_attention");
    expect(info.thread.remoteConversationId).not.toBeNull();
    expect(info.thread.deletedAt).toBeNull();

    const status = await testRuntime.runtime.app.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: authenticatedHeaders(),
    });
    expect(runStatusResponseSchema.parse(status.json()).deletion).toEqual({
      remoteRequested: true,
      remotePermitted: true,
      remoteOutcome: "ambiguous",
      localTombstoned: false,
    });
  });

  it("does not infer remote absence after ambiguous creation", async () => {
    const testRuntime = runtime();
    testRuntime.adapter.enqueueCreateResult({
      ok: false,
      error: {
        code: "submission_ambiguous",
        message: "The create submission may have reached ChatGPT",
        retryable: false,
        observedUrl: null,
      },
    });

    const createResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: authenticatedHeaders({
        "idempotency-key": "create-ambiguous-without-mapping",
      }),
      payload: {
        name: "ambiguous-without-mapping",
        message: "Potentially create a conversation.",
        wait: true,
      },
    });
    expect(createResponse.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(createResponse.json()).error.code).toBe(
      "submission_ambiguous",
    );

    const deleteResponse = await remoteDelete(
      testRuntime,
      "ambiguous-without-mapping",
    );
    expect(deleteResponse.statusCode).toBe(409);
    const error = apiErrorResponseSchema.parse(deleteResponse.json()).error;
    expect(error.code).toBe("remote_delete_ambiguous");
    expect(testRuntime.adapter.deleteCalls).toHaveLength(0);

    const infoResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads/ambiguous-without-mapping",
      headers: authenticatedHeaders(),
    });
    const info = threadDetailResponseSchema.parse(infoResponse.json());
    expect(info.thread.state).toBe("needs_attention");
    expect(info.thread.deletedAt).toBeNull();
  });
});
