import { afterEach, describe, expect, it } from "vitest";

import {
  apiErrorResponseSchema,
  browserStatusResponseSchema,
  doctorResponseSchema,
  listThreadsResponseSchema,
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

function runtime(remoteDeletionEnabled = false): TestRuntime {
  const testRuntime = createTestRuntime(remoteDeletionEnabled);
  openRuntimes.push(testRuntime);
  return testRuntime;
}

afterEach(async () => {
  while (openRuntimes.length > 0) {
    await openRuntimes.pop()?.close();
  }
});

async function createThread(
  testRuntime: TestRuntime,
  name = "architecture-review",
) {
  const response = await testRuntime.runtime.app.inject({
    method: "POST",
    url: "/v1/threads",
    headers: authenticatedHeaders({ "idempotency-key": `create-${name}` }),
    payload: {
      name,
      message: "Review the architecture.",
      wait: true,
    },
  });
  expect(response.statusCode).toBe(201);
  return mutationAcceptedResponseSchema.parse(response.json());
}

describe("HTTP API workflow", () => {
  it("leaves health public and protects all operational endpoints", async () => {
    const testRuntime = runtime();

    const health = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/health",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", version: "0.1.0" });

    const unauthorized = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/browser/status",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(apiErrorResponseSchema.parse(unauthorized.json()).error.code).toBe(
      "unauthorized",
    );

    const browserStatus = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/browser/status",
      headers: authenticatedHeaders(),
    });
    expect(browserStatus.statusCode).toBe(200);
    expect(browserStatusResponseSchema.parse(browserStatus.json()).status).toBe(
      "ready",
    );

    const doctor = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/doctor",
      headers: authenticatedHeaders(),
    });
    expect(doctor.statusCode).toBe(200);
    const report = doctorResponseSchema.parse(doctor.json());
    expect(report.browser.status).toBe("ready");
    expect(report.queue.state).toBe("running");
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "api_token",
        "database_integrity",
        "browser",
        "queue",
      ]),
    );
  });

  it("allows local requests without authorization when token auth is disabled", async () => {
    const testRuntime = createTestRuntime(false, false);
    openRuntimes.push(testRuntime);

    const browserStatus = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/browser/status",
    });
    expect(browserStatus.statusCode).toBe(200);
    expect(browserStatusResponseSchema.parse(browserStatus.json()).status).toBe(
      "ready",
    );

    const doctor = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/doctor",
    });
    expect(doctor.statusCode).toBe(200);
    const report = doctorResponseSchema.parse(doctor.json());
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "api_token",
        status: "warning",
        summary: "API authentication is disabled",
      }),
    );
  });

  it("completes create, retry, chat, info, run, list, and local deletion", async () => {
    const testRuntime = runtime();
    const created = await createThread(testRuntime);
    expect(created.run.state).toBe("succeeded");
    expect(created.run.finalResponse).toBe(
      "Fake response: Review the architecture.",
    );
    expect(created.thread.state).toBe("idle");

    const retriedResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: authenticatedHeaders({
        "idempotency-key": "create-architecture-review",
      }),
      payload: {
        name: "architecture-review",
        message: "Review the architecture.",
        wait: true,
      },
    });
    expect(retriedResponse.statusCode).toBe(201);
    const retried = mutationAcceptedResponseSchema.parse(retriedResponse.json());
    expect(retried.run.id).toBe(created.run.id);
    expect(testRuntime.adapter.createCalls).toHaveLength(1);

    const duplicateResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: authenticatedHeaders({ "idempotency-key": "different-create" }),
      payload: {
        name: "architecture-review",
        message: "Review something else.",
        wait: true,
      },
    });
    expect(duplicateResponse.statusCode).toBe(409);
    expect(
      apiErrorResponseSchema.parse(duplicateResponse.json()).error.code,
    ).toBe("thread_already_exists");

    const chatResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads/architecture-review/messages",
      headers: authenticatedHeaders({ "idempotency-key": "chat-1" }),
      payload: { message: "Now focus on ownership.", wait: true },
    });
    expect(chatResponse.statusCode).toBe(200);
    const chatted = mutationAcceptedResponseSchema.parse(chatResponse.json());
    expect(chatted.run.finalResponse).toBe(
      "Fake response: Now focus on ownership.",
    );

    const infoResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads/architecture-review",
      headers: authenticatedHeaders(),
    });
    const info = threadDetailResponseSchema.parse(infoResponse.json());
    expect(info.history).toHaveLength(2);
    expect(info.thread.remoteConversationId).not.toBeNull();

    const runResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: `/v1/runs/${chatted.run.id}`,
      headers: authenticatedHeaders(),
    });
    const run = runStatusResponseSchema.parse(runResponse.json());
    expect(run.run.state).toBe("succeeded");
    expect(run.deletion).toBeNull();

    const listResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: authenticatedHeaders(),
    });
    expect(listThreadsResponseSchema.parse(listResponse.json()).threads).toHaveLength(
      1,
    );

    const deleteResponse = await testRuntime.runtime.app.inject({
      method: "DELETE",
      url: "/v1/threads/architecture-review",
      headers: authenticatedHeaders({ "idempotency-key": "delete-local" }),
      payload: { delete_remote: false, wait: true },
    });
    expect(deleteResponse.statusCode).toBe(200);
    const deleted = mutationAcceptedResponseSchema.parse(deleteResponse.json());
    expect(deleted.thread.state).toBe("deleted_local");
    expect(testRuntime.adapter.deleteCalls).toHaveLength(0);
    expect(testRuntime.adapter.listConversations()).toHaveLength(1);

    const retriedChatResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads/architecture-review/messages",
      headers: authenticatedHeaders({ "idempotency-key": "chat-1" }),
      payload: { message: "Now focus on ownership.", wait: true },
    });
    expect(retriedChatResponse.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(retriedChatResponse.json()).error.code).toBe(
      "thread_not_found",
    );
    expect(testRuntime.adapter.sendCalls).toHaveLength(1);

    const newChatResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads/architecture-review/messages",
      headers: authenticatedHeaders({ "idempotency-key": "chat-after-delete" }),
      payload: { message: "This must not be sent.", wait: true },
    });
    expect(newChatResponse.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(newChatResponse.json()).error.code).toBe(
      "thread_not_found",
    );
    expect(testRuntime.adapter.sendCalls).toHaveLength(1);

    const secondDeleteResponse = await testRuntime.runtime.app.inject({
      method: "DELETE",
      url: "/v1/threads/architecture-review",
      headers: authenticatedHeaders({ "idempotency-key": "delete-local-again" }),
      payload: { delete_remote: false, wait: true },
    });
    expect(secondDeleteResponse.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(secondDeleteResponse.json()).error.code).toBe(
      "thread_not_found",
    );
    expect(testRuntime.adapter.deleteCalls).toHaveLength(0);

    const defaultList = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: authenticatedHeaders(),
    });
    expect(listThreadsResponseSchema.parse(defaultList.json()).threads).toEqual([]);

    const deletedList = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads?include_deleted=true",
      headers: authenticatedHeaders(),
    });
    expect(listThreadsResponseSchema.parse(deletedList.json()).threads[0]?.state).toBe(
      "deleted_local",
    );

    const recreatedResponse = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: authenticatedHeaders({ "idempotency-key": "recreate-thread" }),
      payload: {
        name: "architecture-review",
        message: "Start a new conversation with this reused local name.",
        wait: true,
      },
    });
    expect(recreatedResponse.statusCode).toBe(201);
    const recreated = mutationAcceptedResponseSchema.parse(
      recreatedResponse.json(),
    );
    expect(recreated.thread.name).toBe("architecture-review");
    expect(recreated.thread.state).toBe("idle");
    expect(
      testRuntime.persistence.threads.getByName("architecture-review")?.state,
    ).toBe("idle");

    const historyAfterRecreate = await testRuntime.runtime.app.inject({
      method: "GET",
      url: "/v1/threads?include_deleted=true",
      headers: authenticatedHeaders(),
    });
    expect(
      listThreadsResponseSchema.parse(historyAfterRecreate.json()).threads.map(
        (thread) => thread.state,
      ),
    ).toEqual(["deleted_local", "idle"]);
  });

  it("returns immediately for no-wait mutations while the durable run continues", async () => {
    const testRuntime = runtime();
    const response = await testRuntime.runtime.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: authenticatedHeaders({ "idempotency-key": "async-create" }),
      payload: {
        name: "async-thread",
        message: "Run asynchronously.",
        wait: false,
      },
    });
    expect(response.statusCode).toBe(202);
    const accepted = mutationAcceptedResponseSchema.parse(response.json());
    expect(accepted.run.state).toBe("queued");

    await testRuntime.runtime.queue.waitForIdle();
    const completedResponse = await testRuntime.runtime.app.inject({
      method: "GET",
      url: `/v1/runs/${accepted.run.id}`,
      headers: authenticatedHeaders(),
    });
    expect(
      runStatusResponseSchema.parse(completedResponse.json()).run.state,
    ).toBe("succeeded");
  });

  it("rejects remote deletion before browser work when disabled", async () => {
    const testRuntime = runtime(false);
    await createThread(testRuntime, "remote-disabled");

    const response = await testRuntime.runtime.app.inject({
      method: "DELETE",
      url: "/v1/threads/remote-disabled",
      headers: authenticatedHeaders({ "idempotency-key": "remote-delete" }),
      payload: { delete_remote: true, wait: true },
    });
    expect(response.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe(
      "remote_delete_disabled",
    );
    expect(testRuntime.adapter.deleteCalls).toHaveLength(0);
    expect(testRuntime.persistence.threads.getByName("remote-disabled")?.state).toBe(
      "idle",
    );
  });

  it("rejects a second distinct deletion while one is pending", async () => {
    const testRuntime = runtime();
    const thread = testRuntime.persistence.threads.create({
      name: "pending-delete",
      state: "delete_pending",
    });
    expect(thread.state).toBe("delete_pending");

    const response = await testRuntime.runtime.app.inject({
      method: "DELETE",
      url: "/v1/threads/pending-delete",
      headers: authenticatedHeaders({ "idempotency-key": "different-delete" }),
      payload: { delete_remote: false, wait: false },
    });
    expect(response.statusCode).toBe(409);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe(
      "thread_busy",
    );
  });

  it("enforces character and byte limits before queueing browser work", async () => {
    const testRuntime = runtime();
    const limitedConfig = {
      ...testRuntime.config,
      limits: {
        ...testRuntime.config.limits,
        maxInputCharacters: 3,
        maxInputBytes: 3,
      },
    };
    await testRuntime.close();
    openRuntimes.pop();

    const replacement = createTestRuntime();
    openRuntimes.push(replacement);
    const service = new (await import("../../src/service/proxy-service.js")).ProxyService(
      limitedConfig,
      replacement.persistence,
      replacement.runtime.queue,
      replacement.adapter,
    );
    const app = (await import("../../src/api/server.js")).createApiServer({
      config: limitedConfig,
      service,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: authenticatedHeaders(),
        payload: { name: "too-large", message: "four", wait: true },
      });
      expect(response.statusCode).toBe(413);
      expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe(
        "input_too_large",
      );
      expect(replacement.adapter.createCalls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
