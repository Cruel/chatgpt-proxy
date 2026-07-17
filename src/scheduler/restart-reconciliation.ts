import type { RunRecord } from "../domain/models.js";
import { isActiveRunState } from "../domain/run-transitions.js";
import type { RunState } from "../domain/states.js";
import type { Persistence } from "../db/persistence.js";

export interface ReconciledRun {
  readonly runId: string;
  readonly previousState: RunState;
  readonly reconciledState: Extract<RunState, "interrupted" | "needs_attention">;
}

function hasPossibleRemoteSideEffect(run: RunRecord): boolean {
  return ["submitted_unconfirmed", "confirmed"].includes(run.submissionState);
}

export function reconcileInterruptedRuns(
  persistence: Persistence,
): readonly ReconciledRun[] {
  const reconciled: ReconciledRun[] = [];

  for (const failedRun of persistence.runs.listRecoverableBrowserFailures()) {
    persistence.transaction(() => {
      persistence.runs.requeueForRecovery(failedRun.id);
      persistence.runEvents.append(
        failedRun.id,
        "run_recovery_queued_after_browser_failure",
        {
          previous_state: failedRun.state,
          submission_state: failedRun.submissionState,
        },
      );
      const thread = persistence.threads.getRequiredById(failedRun.threadId);
      persistence.threads.setState(thread.id, "running");
    });
  }

  for (const activeRun of persistence.runs.listActive()) {
    const thread = persistence.threads.getRequiredById(activeRun.threadId);
    if (
      thread.deletedAt !== null ||
      thread.state === "deleted_local" ||
      thread.state === "deleted_remote"
    ) {
      persistence.transaction(() => {
        persistence.runs.transition(activeRun.id, {
          state: "cancelled",
          phase: "restart_reconciliation",
          errorCode: "thread_deleted",
          errorMessage:
            "Recovery was skipped because the local thread had already been deleted",
        });
        persistence.runEvents.append(
          activeRun.id,
          "run_recovery_skipped_for_deleted_thread",
          { thread_state: thread.state },
        );
        persistence.threads.setState(
          thread.id,
          thread.remoteDeletedAt === null ? "deleted_local" : "deleted_remote",
        );
      });
      continue;
    }
    if (
      activeRun.operationType !== "delete_thread" &&
      activeRun.inputText !== null &&
      thread.remoteConversationId !== null &&
      thread.remoteUrl !== null
    ) {
      persistence.transaction(() => {
        persistence.runs.transition(activeRun.id, {
          state: "interrupted",
          phase: "restart_reconciliation",
          errorCode: "unexpected_state",
          errorMessage:
            "Service restarted while a mapped ChatGPT conversation was active",
        });
        persistence.runs.requeueForRecovery(activeRun.id);
        persistence.runEvents.append(
          activeRun.id,
          "run_recovery_queued_after_restart",
          {
            previous_state: activeRun.state,
            submission_state: activeRun.submissionState,
          },
        );
        persistence.threads.setState(thread.id, "running");
      });
      continue;
    }

    persistence.transaction(() => {
      const run = persistence.runs.getRequiredById(activeRun.id);
      if (!isActiveRunState(run.state)) {
        return;
      }

      const possibleRemoteSideEffect = hasPossibleRemoteSideEffect(run);
      const nextState = possibleRemoteSideEffect
        ? "needs_attention"
        : "interrupted";
      const errorCode =
        run.submissionState === "submitted_unconfirmed"
          ? "submission_ambiguous"
          : "unexpected_state";
      const errorMessage = possibleRemoteSideEffect
        ? "Service restarted after the operation may have reached ChatGPT; inspect the remote conversation before retrying"
        : "Service restarted before submission was confirmed";

      persistence.runs.transition(run.id, {
        state: nextState,
        phase: "restart_reconciliation",
        submissionState: run.submissionState,
        errorCode,
        errorMessage,
      });
      persistence.runEvents.append(run.id, "run_reconciled_after_restart", {
        previous_state: run.state,
        submission_state: run.submissionState,
        reconciled_state: nextState,
      });

      const thread = persistence.threads.getRequiredById(run.threadId);
      if (!(["deleted_local", "deleted_remote"] as const).includes(thread.state as "deleted_local" | "deleted_remote")) {
        if (nextState === "needs_attention") {
          persistence.threads.setState(
            thread.id,
            "needs_attention",
            errorCode,
            errorMessage,
          );
        } else if (run.operationType === "create_thread") {
          persistence.threads.setState(
            thread.id,
            "error",
            errorCode,
            errorMessage,
          );
        } else {
          persistence.threads.setState(thread.id, "idle");
        }
      }

      reconciled.push({
        runId: run.id,
        previousState: run.state,
        reconciledState: nextState,
      });
    });
  }

  return reconciled;
}
