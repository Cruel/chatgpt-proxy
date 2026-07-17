import type {
  OperationType,
  RunState,
  SubmissionState,
  ThinkingLevel,
  ThreadState,
} from "./states.js";

export interface ThreadRecord {
  readonly id: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly remoteConversationId: string | null;
  readonly remoteUrl: string | null;
  readonly remoteTitle: string | null;
  readonly state: ThreadState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly remoteDeletedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
}

export interface RunRecord {
  readonly id: string;
  readonly threadId: string;
  readonly operationType: OperationType;
  readonly inputText: string | null;
  readonly inputSha256: string | null;
  readonly idempotencyKey: string | null;
  readonly thinkingLevel: ThinkingLevel;
  readonly state: RunState;
  readonly phase: string;
  readonly submissionState: SubmissionState;
  readonly deleteRemoteRequested: boolean;
  readonly deleteRemotePermitted: boolean;
  readonly finalResponse: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface RunEventRecord {
  readonly id: number;
  readonly runId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export const ARTIFACT_TYPES = [
  "screenshot",
  "html",
  "trace",
  "dom_fragment",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactRecord {
  readonly id: string;
  readonly runId: string;
  readonly artifactType: ArtifactType;
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface ThreadMessageRecord {
  readonly runId: string;
  readonly operationType: Extract<
    OperationType,
    "create_thread" | "send_message"
  >;
  readonly inputText: string;
  readonly finalResponse: string | null;
  readonly state: RunState;
  readonly createdAt: string;
  readonly completedAt: string | null;
}
