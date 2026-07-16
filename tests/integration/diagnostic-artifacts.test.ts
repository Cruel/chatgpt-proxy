import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DiagnosticArtifactDraft } from "../../src/browser/adapter.js";
import { FakeBrowserAdapter } from "../../src/browser/fake/index.js";
import { parseConfigText } from "../../src/config/index.js";
import { openPersistence, type Persistence } from "../../src/db/index.js";
import { createProxyRuntime } from "../../src/runtime.js";
import { DiagnosticArtifactStore } from "../../src/service/index.js";

interface OpenedStore {
  readonly directory: string;
  readonly persistence: Persistence;
}

const openedStores: OpenedStore[] = [];

afterEach(async () => {
  while (openedStores.length > 0) {
    const opened = openedStores.pop();
    opened?.persistence.close();
    if (opened !== undefined) {
      await rm(opened.directory, { recursive: true, force: true });
    }
  }
});

describe("diagnostic artifact storage", () => {
  it("writes private artifacts, records hashes, and prunes expired files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-proxy-artifacts-"));
    let now = new Date("2026-01-01T00:00:00.000Z");
    const persistence = openPersistence(join(directory, "state.sqlite3"), {
      now: () => now.toISOString(),
    });
    openedStores.push({ directory, persistence });

    const thread = persistence.threads.create({ name: "Diagnostics" });
    const run = persistence.runs.createOrGet({
      id: "diagnostic-run",
      threadId: thread.id,
      operationType: "create_thread",
      inputText: "Trigger diagnostics.",
    }).run;
    const store = new DiagnosticArtifactStore({
      artifactDirectory: join(directory, "artifacts"),
      persistence,
      retainDays: 30,
      now: () => now,
    });
    const drafts: DiagnosticArtifactDraft[] = [
      {
        type: "html",
        mediaType: "text/html",
        suggestedExtension: "html",
        data: new TextEncoder().encode("<main>failure</main>"),
      },
      {
        type: "dom_fragment",
        mediaType: "application/json",
        suggestedExtension: "json",
        data: new TextEncoder().encode('{"failure":"ui_changed"}'),
      },
    ];

    const records = await store.persist(run.id, "project navigation", drafts);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.artifactType).sort()).toEqual([
      "dom_fragment",
      "html",
    ]);
    for (const record of records) {
      expect(existsSync(record.path)).toBe(true);
      expect(statSync(record.path).mode & 0o777).toBe(0o600);
      expect(record.sha256).toMatch(/^[a-f\d]{64}$/);
    }

    now = new Date("2026-02-01T00:00:00.000Z");
    expect(store.pruneExpired()).toBe(2);
    expect(persistence.artifacts.listByRun(run.id)).toEqual([]);
    for (const record of records) {
      expect(existsSync(record.path)).toBe(false);
    }
  });

  it("persists adapter diagnostics before completing a failed run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatgpt-proxy-runtime-artifacts-"));
    const persistence = openPersistence(join(directory, "state.sqlite3"));
    openedStores.push({ directory, persistence });
    const config = parseConfigText(
      `
[server]
api_token = "test-token"

[chatgpt]
project_url = "https://chatgpt.com/g/g-p-example/project"

[diagnostics]
artifact_dir = "./artifacts"
capture_screenshot_on_error = true
capture_html_on_error = true
capture_trace_on_error = true
retain_days = 30
`,
      { baseDirectory: directory },
    );
    const adapter = new FakeBrowserAdapter();
    adapter.enqueueCreateResult({
      ok: false,
      error: {
        code: "ui_changed",
        message: "Fixture controls changed",
        retryable: false,
        observedUrl: config.chatGpt.projectUrl,
      },
    });
    adapter.enqueueDiagnosticResult({
      ok: true,
      value: [
        {
          type: "dom_fragment",
          mediaType: "application/json",
          suggestedExtension: "json",
          data: new TextEncoder().encode('{"failure":"ui_changed"}'),
        },
      ],
    });
    const runtime = createProxyRuntime({ config, adapter, persistence });
    try {
      const result = await runtime.service.createThread({
        name: "Diagnostic capture",
        message: "Trigger a changed UI.",
        wait: true,
        idempotencyKey: undefined,
      });
      expect(result.run.state).toBe("failed");
      const run = persistence.runs.getRequiredById(result.run.id);
      const artifacts = persistence.artifacts.listByRun(run.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.artifactType).toBe("dom_fragment");
      expect(existsSync(artifacts[0]?.path ?? "")).toBe(true);
      expect(adapter.diagnosticCalls).toEqual([
        {
          runId: run.id,
          phase: "creating_conversation",
          includeScreenshot: true,
          includeHtml: true,
          includeTrace: true,
        },
      ]);
      expect(
        persistence.runEvents
          .listByRun(run.id)
          .map((event) => event.eventType),
      ).toContain("diagnostic_artifacts_captured");
    } finally {
      await runtime.close();
    }
  });
});
