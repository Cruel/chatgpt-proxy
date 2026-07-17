import type { Persistence } from "../db/persistence.js";
import type {
  RunEventRecord,
  RunRecord,
  ThreadRecord,
} from "../domain/models.js";
import type {
  RunSummary,
  ThreadSummary,
} from "./schemas.js";

const PENDING_RUN_STATES = new Set([
  "queued",
  "navigating",
  "submitting",
  "running",
  "needs_attention",
]);

export interface DeletionStatus {
  readonly remoteRequested: boolean;
  readonly remotePermitted: boolean;
  readonly remoteOutcome: "deleted" | "already_absent" | "ambiguous" | null;
  readonly localTombstoned: boolean;
}

export function presentRun(run: RunRecord): RunSummary {
  return {
    id: run.id,
    operationType: run.operationType,
    thinkingLevel: run.thinkingLevel,
    state: run.state,
    phase: run.phase,
    submissionState: run.submissionState,
    deleteRemoteRequested: run.deleteRemoteRequested,
    deleteRemotePermitted: run.deleteRemotePermitted,
    finalResponse: run.finalResponse,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

export function findPendingRun(runs: readonly RunRecord[]): RunRecord | null {
  return (
    [...runs]
      .reverse()
      .find((run) => PENDING_RUN_STATES.has(run.state)) ?? null
  );
}

export function presentThread(
  thread: ThreadRecord,
  runs: readonly RunRecord[],
): ThreadSummary {
  const pendingRun = findPendingRun(runs);
  const lastCompletedAt = [...runs]
    .reverse()
    .find((run) => run.completedAt !== null)?.completedAt ?? null;

  return {
    name: thread.name,
    state: thread.state,
    hasRemoteMapping:
      thread.remoteConversationId !== null && thread.remoteUrl !== null,
    pendingOperation: pendingRun === null ? null : presentRun(pendingRun),
    lastCompletedAt,
    lastErrorCode: thread.lastErrorCode,
    lastErrorMessage: thread.lastErrorMessage,
    deletedAt: thread.deletedAt,
    remoteDeletedAt: thread.remoteDeletedAt,
  };
}

function eventOutcome(
  event: RunEventRecord,
): DeletionStatus["remoteOutcome"] {
  const outcome = event.payload.outcome;
  return outcome === "deleted" ||
    outcome === "already_absent" ||
    outcome === "ambiguous"
    ? outcome
    : null;
}

export function presentDeletionStatus(
  run: RunRecord,
  events: readonly RunEventRecord[],
): DeletionStatus | null {
  if (run.operationType !== "delete_thread") {
    return null;
  }

  const remoteEvent = [...events]
    .reverse()
    .find((event) => event.eventType === "remote_delete_result");
  const localTombstoned = events.some(
    (event) => event.eventType === "local_thread_tombstoned",
  );

  return {
    remoteRequested: run.deleteRemoteRequested,
    remotePermitted: run.deleteRemotePermitted,
    remoteOutcome: remoteEvent === undefined ? null : eventOutcome(remoteEvent),
    localTombstoned,
  };
}

export function presentThreadDetail(
  persistence: Persistence,
  thread: ThreadRecord,
) {
  const runs = persistence.runs.listByThread(thread.id);
  const pendingRun = findPendingRun(runs);
  return {
    thread: {
      ...presentThread(thread, runs),
      remoteConversationId: thread.remoteConversationId,
      remoteUrl: thread.remoteUrl,
      remoteTitle: thread.remoteTitle,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    },
    pendingRun: pendingRun === null ? null : presentRun(pendingRun),
    history: persistence.runs.listMessagesByThread(thread.id),
    diagnosticArtifactCount: persistence.artifacts.countByThread(thread.id),
  };
}
