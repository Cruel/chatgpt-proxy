import { z } from "zod";

export const THREAD_STATES = [
  "provisioning",
  "idle",
  "running",
  "needs_attention",
  "delete_pending",
  "delete_failed",
  "deleted_local",
  "deleted_remote",
  "orphaned",
  "error",
] as const;

export const RUN_STATES = [
  "queued",
  "navigating",
  "submitting",
  "running",
  "needs_attention",
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
] as const;

export const SUBMISSION_STATES = [
  "not_started",
  "typed",
  "submitted_unconfirmed",
  "confirmed",
] as const;

export const OPERATION_TYPES = [
  "create_thread",
  "send_message",
  "delete_thread",
] as const;

export const THINKING_LEVELS = ["instant", "medium", "high"] as const;

export const BROWSER_STATUSES = [
  "starting",
  "ready",
  "auth_required",
  "verification_required",
  "recovering",
  "unavailable",
  "stopping",
] as const;

export const API_ERROR_CODES = [
  "unauthorized",
  "invalid_request",
  "thread_already_exists",
  "idempotency_conflict",
  "auth_required",
  "verification_required",
  "project_not_found",
  "thread_not_found",
  "run_not_found",
  "thread_deleted",
  "thread_busy",
  "input_too_large",
  "queue_full",
  "input_not_found",
  "send_failed",
  "submission_ambiguous",
  "response_timeout",
  "tool_failed",
  "needs_confirmation",
  "rate_limited",
  "browser_crashed",
  "navigation_failed",
  "remote_delete_disabled",
  "remote_delete_failed",
  "remote_delete_ambiguous",
  "ui_changed",
  "unexpected_state",
] as const;

export const threadStateSchema = z.enum(THREAD_STATES);
export const runStateSchema = z.enum(RUN_STATES);
export const submissionStateSchema = z.enum(SUBMISSION_STATES);
export const operationTypeSchema = z.enum(OPERATION_TYPES);
export const thinkingLevelSchema = z.enum(THINKING_LEVELS);
export const browserStatusSchema = z.enum(BROWSER_STATUSES);
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export type ThreadState = z.infer<typeof threadStateSchema>;
export type RunState = z.infer<typeof runStateSchema>;
export type SubmissionState = z.infer<typeof submissionStateSchema>;
export type OperationType = z.infer<typeof operationTypeSchema>;
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type BrowserStatus = z.infer<typeof browserStatusSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
