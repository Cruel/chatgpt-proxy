import {
  ARTIFACT_TYPES,
  type ArtifactRecord,
  type ArtifactType,
  type RunEventRecord,
  type RunRecord,
  type ThreadRecord,
} from "../domain/models.js";
import {
  operationTypeSchema,
  runStateSchema,
  submissionStateSchema,
  threadStateSchema,
} from "../domain/states.js";

export interface ThreadRow {
  readonly id: string;
  readonly name: string;
  readonly normalized_name: string;
  readonly remote_conversation_id: string | null;
  readonly remote_url: string | null;
  readonly remote_title: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly remote_deleted_at: string | null;
  readonly last_error_code: string | null;
  readonly last_error_message: string | null;
}

export interface RunRow {
  readonly id: string;
  readonly thread_id: string;
  readonly operation_type: string;
  readonly input_text: string | null;
  readonly input_sha256: string | null;
  readonly idempotency_key: string | null;
  readonly state: string;
  readonly phase: string;
  readonly submission_state: string;
  readonly delete_remote_requested: number;
  readonly delete_remote_permitted: number;
  readonly final_response: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export interface RunEventRow {
  readonly id: number;
  readonly run_id: string;
  readonly event_type: string;
  readonly payload_json: string;
  readonly created_at: string;
}

export interface ArtifactRow {
  readonly id: string;
  readonly run_id: string;
  readonly artifact_type: string;
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly created_at: string;
}

function parseArtifactType(value: string): ArtifactType {
  if ((ARTIFACT_TYPES as readonly string[]).includes(value)) {
    return value as ArtifactType;
  }

  throw new Error(`Unknown artifact type '${value}' in database`);
}

function parsePayload(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Run event payload must be a JSON object");
  }

  return parsed as Readonly<Record<string, unknown>>;
}

export function mapThreadRow(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    name: row.name,
    normalizedName: row.normalized_name,
    remoteConversationId: row.remote_conversation_id,
    remoteUrl: row.remote_url,
    remoteTitle: row.remote_title,
    state: threadStateSchema.parse(row.state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    remoteDeletedAt: row.remote_deleted_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  };
}

export function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    operationType: operationTypeSchema.parse(row.operation_type),
    inputText: row.input_text,
    inputSha256: row.input_sha256,
    idempotencyKey: row.idempotency_key,
    state: runStateSchema.parse(row.state),
    phase: row.phase,
    submissionState: submissionStateSchema.parse(row.submission_state),
    deleteRemoteRequested: row.delete_remote_requested === 1,
    deleteRemotePermitted: row.delete_remote_permitted === 1,
    finalResponse: row.final_response,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function mapRunEventRow(row: RunEventRow): RunEventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    eventType: row.event_type,
    payload: parsePayload(row.payload_json),
    createdAt: row.created_at,
  };
}

export function mapArtifactRow(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    artifactType: parseArtifactType(row.artifact_type),
    path: row.path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}
