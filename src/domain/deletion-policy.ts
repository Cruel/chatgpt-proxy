export type DeletionPolicyDecision =
  | { readonly kind: "local_only" }
  | { readonly kind: "remote_allowed" }
  | {
      readonly kind: "rejected";
      readonly errorCode: "remote_delete_disabled";
    };

export function decideDeletionPolicy(input: {
  readonly remoteDeletionConfigured: boolean;
  readonly remoteDeletionRequested: boolean;
}): DeletionPolicyDecision {
  if (!input.remoteDeletionRequested) {
    return { kind: "local_only" };
  }

  if (!input.remoteDeletionConfigured) {
    return {
      kind: "rejected",
      errorCode: "remote_delete_disabled",
    };
  }

  return { kind: "remote_allowed" };
}
