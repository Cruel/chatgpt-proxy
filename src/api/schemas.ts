import { z } from "zod";

import {
  apiErrorCodeSchema,
  browserStatusSchema,
  operationTypeSchema,
  runStateSchema,
  submissionStateSchema,
  threadStateSchema,
} from "../domain/states.js";

export const threadNameSchema = z.string().trim().min(1).max(200);
export const messageInputSchema = z.string().min(1);
export const idempotencyKeySchema = z.string().trim().min(1).max(255);
export const runIdSchema = z.string().uuid();
export const timestampSchema = z.string().datetime({ offset: true });

export const healthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  version: z.string().min(1),
});

export const browserStatusResponseSchema = z.strictObject({
  status: browserStatusSchema,
  detail: z.string().nullable(),
  activePageCount: z.number().int().nonnegative(),
  queuedRunCount: z.number().int().nonnegative(),
  observedAt: timestampSchema,
});

export const listThreadsQuerySchema = z.strictObject({
  include_deleted: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(false)
    .transform((value) => value === true || value === "true"),
});

export const createThreadRequestSchema = z.strictObject({
  name: threadNameSchema,
  message: messageInputSchema,
  wait: z.boolean().default(true),
});

export const sendMessageRequestSchema = z.strictObject({
  message: messageInputSchema,
  wait: z.boolean().default(true),
});

export const deleteThreadRequestSchema = z
  .strictObject({
    delete_remote: z.boolean().default(false),
    wait: z.boolean().default(true),
  })
  .prefault({});

export const threadPathParametersSchema = z.strictObject({
  name: threadNameSchema,
});

export const runPathParametersSchema = z.strictObject({
  run_id: runIdSchema,
});

export const idempotencyHeadersSchema = z.strictObject({
  "idempotency-key": idempotencyKeySchema.optional(),
});

export const runSummarySchema = z.strictObject({
  id: runIdSchema,
  operationType: operationTypeSchema,
  state: runStateSchema,
  phase: z.string(),
  submissionState: submissionStateSchema,
  deleteRemoteRequested: z.boolean(),
  deleteRemotePermitted: z.boolean(),
  finalResponse: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  completedAt: timestampSchema.nullable(),
});

export const threadSummarySchema = z.strictObject({
  name: z.string(),
  state: threadStateSchema,
  hasRemoteMapping: z.boolean(),
  pendingOperation: runSummarySchema.nullable(),
  lastCompletedAt: timestampSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  deletedAt: timestampSchema.nullable(),
  remoteDeletedAt: timestampSchema.nullable(),
});

export const listThreadsResponseSchema = z.strictObject({
  threads: z.array(threadSummarySchema),
});

export const threadHistoryEntrySchema = z.strictObject({
  runId: runIdSchema,
  operationType: z.enum(["create_thread", "send_message"]),
  inputText: z.string(),
  finalResponse: z.string().nullable(),
  state: runStateSchema,
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});

export const threadDetailResponseSchema = z.strictObject({
  thread: threadSummarySchema.extend({
    remoteConversationId: z.string().nullable(),
    remoteUrl: z.string().url().nullable(),
    remoteTitle: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
  pendingRun: runSummarySchema.nullable(),
  history: z.array(threadHistoryEntrySchema),
  diagnosticArtifactCount: z.number().int().nonnegative(),
});

export const mutationAcceptedResponseSchema = z.strictObject({
  run: runSummarySchema,
  thread: threadSummarySchema,
});

export const runStatusResponseSchema = z.strictObject({
  run: runSummarySchema,
  deletion: z
    .strictObject({
      remoteRequested: z.boolean(),
      remotePermitted: z.boolean(),
      remoteOutcome: z
        .enum(["deleted", "already_absent", "ambiguous"])
        .nullable(),
      localTombstoned: z.boolean(),
    })
    .nullable(),
});

export const apiErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type DeleteThreadRequest = z.infer<typeof deleteThreadRequestSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
