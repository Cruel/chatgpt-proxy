import type {
  BrowserAdapter,
  BrowserAdapterFailure,
  RemoteConversationReference,
} from "../browser/adapter.js";
import type { AppConfig } from "../config/schema.js";
import type { RunRecord, ThreadRecord } from "../domain/models.js";
import type { ThreadState } from "../domain/states.js";
import type {
  RunExecutionContext,
  RunExecutionResult,
  RunExecutor,
} from "../scheduler/durable-run-queue.js";
import type { DiagnosticArtifactStore } from "./diagnostic-artifact-store.js";

export interface BrowserRunExecutorOptions {
  readonly adapter: BrowserAdapter;
  readonly config: AppConfig;
  readonly artifactStore: DiagnosticArtifactStore;
}

function failureOutcome(
  failure: BrowserAdapterFailure,
): RunExecutionResult {
  if (
    failure.code === "auth_required" ||
    failure.code === "verification_required" ||
    failure.code === "submission_ambiguous" ||
    failure.code === "remote_delete_ambiguous" ||
    failure.code === "needs_confirmation"
  ) {
    return {
      outcome: "needs_attention",
      errorCode: failure.code,
      errorMessage: failure.message,
    };
  }

  if (failure.code === "response_timeout") {
    return {
      outcome: "timed_out",
      errorCode: failure.code,
      errorMessage: failure.message,
    };
  }

  return {
    outcome: "failed",
    errorCode: failure.code,
    errorMessage: failure.message,
  };
}

function remoteReference(thread: ThreadRecord): RemoteConversationReference | null {
  if (thread.remoteConversationId === null || thread.remoteUrl === null) {
    return null;
  }

  return {
    conversationId: thread.remoteConversationId,
    url: thread.remoteUrl,
    title: thread.remoteTitle,
  };
}

function failureThreadState(result: RunExecutionResult): ThreadState {
  return result.outcome === "needs_attention" ? "needs_attention" : "error";
}

export class BrowserRunExecutor implements RunExecutor {
  private readonly adapter: BrowserAdapter;
  private readonly config: AppConfig;
  private readonly artifactStore: DiagnosticArtifactStore;

  public constructor(options: BrowserRunExecutorOptions) {
    this.adapter = options.adapter;
    this.config = options.config;
    this.artifactStore = options.artifactStore;
  }

  public async execute(
    run: RunRecord,
    context: RunExecutionContext,
  ): Promise<RunExecutionResult> {
    try {
      switch (run.operationType) {
        case "create_thread":
          return await this.createThread(run, context);
        case "send_message":
          return await this.sendMessage(run, context);
        case "delete_thread":
          return await this.deleteThread(run, context);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.captureFailureDiagnostics(
        run,
        {
          code: "unexpected_state",
          message,
          retryable: false,
          observedUrl: null,
        },
        context,
      );
      const thread = context.persistence.threads.getRequiredById(run.threadId);
      if (thread.state !== "delete_pending") {
        context.persistence.threads.setState(
          thread.id,
          "error",
          "unexpected_state",
          message,
        );
      }
      throw error;
    }
  }

  private async createThread(
    run: RunRecord,
    context: RunExecutionContext,
  ): Promise<RunExecutionResult> {
    const thread = context.persistence.threads.getRequiredById(run.threadId);
    const message = this.requireInput(run);
    this.markThreadRunning(thread.id, context);
    context.updateProgress({ state: "navigating", phase: "project_navigation" });
    context.updateProgress({
      state: "submitting",
      phase: "creating_conversation",
      submissionState: "typed",
    });

    const result = await this.adapter.createConversation(
      {
        projectUrl: this.config.chatGpt.projectUrl,
        message,
      },
      {
        runId: run.id,
        threadId: thread.id,
        signal: context.signal,
        onConversationIdentified: (conversation) => {
          context.persistence.threads.setRemoteMapping(thread.id, {
            conversationId: conversation.conversationId,
            url: conversation.url,
            title: conversation.title,
          });
          context.recordEvent("remote_conversation_identified", {
            conversation_id: conversation.conversationId,
            url: conversation.url,
          });
        },
      },
    );

    if (!result.ok) {
      await this.captureFailureDiagnostics(run, result.error, context);
      if (result.error.code === "submission_ambiguous") {
        context.updateProgress({
          state: "submitting",
          phase: "submission_ambiguous",
          submissionState: "submitted_unconfirmed",
        });
      }
      const outcome = failureOutcome(result.error);
      this.markThreadFailure(
        thread.id,
        failureThreadState(outcome),
        result.error.code,
        result.error.message,
        context,
      );
      return outcome;
    }

    context.updateProgress({
      state: "running",
      phase: "response_completed",
      submissionState: "confirmed",
    });
    context.persistence.threads.setRemoteMapping(thread.id, {
      conversationId: result.value.conversation.conversationId,
      url: result.value.conversation.url,
      title: result.value.conversation.title,
    });
    this.restoreThreadReadyState(thread.id, run.id, context);
    return { outcome: "succeeded", finalResponse: result.value.text };
  }

  private async sendMessage(
    run: RunRecord,
    context: RunExecutionContext,
  ): Promise<RunExecutionResult> {
    const thread = context.persistence.threads.getRequiredById(run.threadId);
    const conversation = remoteReference(thread);
    if (conversation === null) {
      context.persistence.threads.setState(
        thread.id,
        "orphaned",
        "thread_not_found",
        "The local thread has no remote conversation mapping",
      );
      return {
        outcome: "failed",
        errorCode: "thread_not_found",
        errorMessage: "The local thread has no remote conversation mapping",
      };
    }

    const message = this.requireInput(run);
    this.markThreadRunning(thread.id, context);
    context.updateProgress({ state: "navigating", phase: "conversation_navigation" });
    context.updateProgress({
      state: "submitting",
      phase: "sending_message",
      submissionState: "typed",
    });

    const result = await this.adapter.sendMessage(
      { conversation, message },
      {
        runId: run.id,
        threadId: thread.id,
        signal: context.signal,
      },
    );
    if (!result.ok) {
      await this.captureFailureDiagnostics(run, result.error, context);
      if (result.error.code === "submission_ambiguous") {
        context.updateProgress({
          state: "submitting",
          phase: "submission_ambiguous",
          submissionState: "submitted_unconfirmed",
        });
      }
      const outcome = failureOutcome(result.error);
      this.markThreadFailure(
        thread.id,
        failureThreadState(outcome),
        result.error.code,
        result.error.message,
        context,
      );
      return outcome;
    }

    context.updateProgress({
      state: "running",
      phase: "response_completed",
      submissionState: "confirmed",
    });
    context.persistence.threads.setRemoteMapping(thread.id, {
      conversationId: result.value.conversation.conversationId,
      url: result.value.conversation.url,
      title: result.value.conversation.title,
    });
    this.restoreThreadReadyState(thread.id, run.id, context);
    return { outcome: "succeeded", finalResponse: result.value.text };
  }

  private async deleteThread(
    run: RunRecord,
    context: RunExecutionContext,
  ): Promise<RunExecutionResult> {
    const thread = context.persistence.threads.getRequiredById(run.threadId);

    if (!run.deleteRemoteRequested) {
      if (
        thread.state === "deleted_local" ||
        thread.state === "deleted_remote"
      ) {
        context.recordEvent("local_thread_tombstoned", {
          remote_deleted: thread.state === "deleted_remote",
          already_tombstoned: true,
        });
        return { outcome: "succeeded", finalResponse: null };
      }
      context.persistence.threads.setState(thread.id, "delete_pending");
      context.persistence.threads.setState(thread.id, "deleted_local");
      context.recordEvent("local_thread_tombstoned", { remote_deleted: false });
      return { outcome: "succeeded", finalResponse: null };
    }

    if (!run.deleteRemotePermitted) {
      context.persistence.threads.setState(
        thread.id,
        "delete_failed",
        "remote_delete_disabled",
        "Remote deletion is disabled by configuration",
      );
      return {
        outcome: "failed",
        errorCode: "remote_delete_disabled",
        errorMessage: "Remote deletion is disabled by configuration",
      };
    }

    context.persistence.threads.setState(thread.id, "delete_pending");

    const conversation = remoteReference(thread);
    if (conversation === null) {
      const uncertainRemoteCreation = context.persistence.runs
        .listByThread(thread.id)
        .some(
          (candidate) =>
            candidate.operationType === "create_thread" &&
            ["submitted_unconfirmed", "confirmed"].includes(
              candidate.submissionState,
            ),
        );
      if (uncertainRemoteCreation) {
        context.recordEvent("remote_delete_result", {
          outcome: "ambiguous",
          evidence: [
            "local remote mapping is absent",
            "a create operation may have reached ChatGPT",
          ],
        });
        context.persistence.threads.setState(
          thread.id,
          "needs_attention",
          "remote_delete_ambiguous",
          "Remote absence cannot be proven because creation may have reached ChatGPT",
        );
        return {
          outcome: "needs_attention",
          errorCode: "remote_delete_ambiguous",
          errorMessage:
            "Remote absence cannot be proven because creation may have reached ChatGPT",
        };
      }
      context.recordEvent("remote_delete_result", {
        outcome: "already_absent",
        evidence: ["local remote mapping was absent"],
      });
      context.persistence.threads.setState(thread.id, "deleted_remote");
      context.recordEvent("local_thread_tombstoned", { remote_deleted: true });
      return { outcome: "succeeded", finalResponse: null };
    }

    context.updateProgress({ state: "navigating", phase: "delete_navigation" });
    context.updateProgress({ state: "running", phase: "deleting_remote_thread" });
    const result = await this.adapter.deleteConversation(conversation, {
      runId: run.id,
      threadId: thread.id,
      signal: context.signal,
    });

    if (!result.ok) {
      await this.captureFailureDiagnostics(run, result.error, context);
      const outcome = failureOutcome(result.error);
      context.persistence.threads.setState(
        thread.id,
        outcome.outcome === "needs_attention" ? "needs_attention" : "delete_failed",
        result.error.code,
        result.error.message,
      );
      return outcome;
    }

    context.recordEvent("remote_delete_result", {
      outcome: result.value.outcome,
      evidence: result.value.evidence,
    });
    if (result.value.outcome === "ambiguous") {
      context.persistence.threads.setState(
        thread.id,
        "needs_attention",
        "remote_delete_ambiguous",
        "Remote deletion could not be confirmed",
      );
      return {
        outcome: "needs_attention",
        errorCode: "remote_delete_ambiguous",
        errorMessage: "Remote deletion could not be confirmed",
      };
    }

    context.persistence.threads.setState(thread.id, "deleted_remote");
    context.recordEvent("local_thread_tombstoned", { remote_deleted: true });
    return { outcome: "succeeded", finalResponse: null };
  }

  private requireInput(run: RunRecord): string {
    if (run.inputText === null) {
      throw new Error(`Run '${run.id}' is missing required input text`);
    }
    return run.inputText;
  }

  private async captureFailureDiagnostics(
    run: RunRecord,
    failure: BrowserAdapterFailure,
    context: RunExecutionContext,
  ): Promise<void> {
    const current = context.persistence.runs.getRequiredById(run.id);
    const diagnosticContext = {
      runId: run.id,
      threadId: run.threadId,
      signal: context.signal,
    };
    const captured = await this.adapter
      .captureDiagnostics(
        {
          runId: run.id,
          phase: current.phase,
          includeScreenshot:
            this.config.diagnostics.captureScreenshotOnError,
          includeHtml: this.config.diagnostics.captureHtmlOnError,
          includeTrace: this.config.diagnostics.captureTraceOnError,
        },
        diagnosticContext,
      )
      .catch((error: unknown) => ({
        ok: false as const,
        error: {
          code: "unexpected_state" as const,
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          observedUrl: null,
        },
      }));

    if (!captured.ok) {
      context.recordEvent("diagnostic_capture_failed", {
        failure_code: failure.code,
        capture_error_code: captured.error.code,
        capture_error_message: captured.error.message,
      });
      return;
    }

    try {
      const artifacts = await this.artifactStore.persist(
        run.id,
        current.phase,
        captured.value,
      );
      if (artifacts.length === 0) {
        return;
      }
      context.recordEvent("diagnostic_artifacts_captured", {
        failure_code: failure.code,
        phase: current.phase,
        submission_state: current.submissionState,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          type: artifact.artifactType,
          path: artifact.path,
          sha256: artifact.sha256,
          size_bytes: artifact.sizeBytes,
        })),
      });
    } catch (error) {
      context.recordEvent("diagnostic_persistence_failed", {
        failure_code: failure.code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private restoreThreadReadyState(
    threadId: string,
    currentRunId: string,
    context: RunExecutionContext,
  ): void {
    const thread = context.persistence.threads.getRequiredById(threadId);
    if (thread.state === "delete_pending") {
      return;
    }
    const hasPendingRun = context.persistence.runs
      .listByThread(threadId)
      .some(
        (candidate) =>
          candidate.id !== currentRunId &&
          ["queued", "navigating", "submitting", "running"].includes(
            candidate.state,
          ),
      );
    context.persistence.threads.setState(
      threadId,
      hasPendingRun ? "running" : "idle",
    );
  }

  private markThreadRunning(
    threadId: string,
    context: RunExecutionContext,
  ): void {
    const current = context.persistence.threads.getRequiredById(threadId);
    if (current.state !== "delete_pending") {
      context.persistence.threads.setState(threadId, "running");
    }
  }

  private markThreadFailure(
    threadId: string,
    failureState: ThreadState,
    errorCode: string,
    errorMessage: string,
    context: RunExecutionContext,
  ): void {
    const current = context.persistence.threads.getRequiredById(threadId);
    if (current.state !== "delete_pending") {
      context.persistence.threads.setState(
        threadId,
        failureState,
        errorCode,
        errorMessage,
      );
    }
  }
}
