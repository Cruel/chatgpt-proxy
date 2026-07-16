import type { RunState } from "./states.js";

const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["navigating", "cancelled", "interrupted"],
  navigating: [
    "submitting",
    "running",
    "needs_attention",
    "succeeded",
    "failed",
    "timed_out",
    "interrupted",
    "cancelled",
  ],
  submitting: [
    "running",
    "needs_attention",
    "succeeded",
    "failed",
    "timed_out",
    "interrupted",
    "cancelled",
  ],
  running: [
    "needs_attention",
    "succeeded",
    "failed",
    "timed_out",
    "interrupted",
    "cancelled",
  ],
  needs_attention: ["queued", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  interrupted: ["queued", "failed", "cancelled"],
  cancelled: [],
};

export function canTransitionRunState(
  currentState: RunState,
  nextState: RunState,
): boolean {
  return (
    currentState === nextState ||
    ALLOWED_RUN_TRANSITIONS[currentState].includes(nextState)
  );
}

export function isCompletedRunState(state: RunState): boolean {
  return [
    "succeeded",
    "failed",
    "timed_out",
    "interrupted",
    "cancelled",
  ].includes(state);
}

export function isActiveRunState(state: RunState): boolean {
  return ["navigating", "submitting", "running"].includes(state);
}
