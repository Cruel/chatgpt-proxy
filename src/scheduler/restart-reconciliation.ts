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

  for (const activeRun of persistence.runs.listActive()) {
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
