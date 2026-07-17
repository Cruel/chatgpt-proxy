export interface CliGlobalOptions {
  readonly serverUrl: string;
  readonly apiToken: string | undefined;
  readonly json: boolean;
  readonly timeout: string | undefined;
}

export type CliThinkingLevel = "instant" | "medium" | "high";

export type PromptInput =
  | { readonly kind: "message"; readonly value: string }
  | { readonly kind: "file"; readonly value: string }
  | { readonly kind: "stdin" };

export type CliCommand =
  | { readonly kind: "health" }
  | { readonly kind: "doctor" }
  | { readonly kind: "browser-status" }
  | { readonly kind: "threads"; readonly includeDeleted: boolean }
  | {
      readonly kind: "new";
      readonly name: string;
      readonly input: PromptInput;
      readonly thinking?: CliThinkingLevel;
      readonly wait: boolean;
      readonly idempotencyKey: string | undefined;
    }
  | {
      readonly kind: "chat";
      readonly name: string;
      readonly input: PromptInput;
      readonly thinking?: CliThinkingLevel;
      readonly wait: boolean;
      readonly idempotencyKey: string | undefined;
    }
  | { readonly kind: "info"; readonly name: string }
  | {
      readonly kind: "run";
      readonly runId: string;
      readonly wait: boolean;
    }
  | {
      readonly kind: "delete";
      readonly name: string;
      readonly remote: boolean;
      readonly yes: boolean;
      readonly wait: boolean;
      readonly idempotencyKey: string | undefined;
    };

export interface CliInvocation {
  readonly command: CliCommand;
  readonly options: CliGlobalOptions;
}

export interface CliCommandExecutor {
  execute(invocation: CliInvocation): Promise<void>;
}
