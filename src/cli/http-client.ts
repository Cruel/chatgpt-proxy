import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import type {
  CliCommand,
  CliCommandExecutor,
  CliInvocation,
  PromptInput,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 31 * 60 * 1_000;
const RUN_POLL_INTERVAL_MILLISECONDS = 1_000;
const TERMINAL_RUN_STATES = new Set([
  "needs_attention",
  "succeeded",
  "failed",
  "timed_out",
  "interrupted",
  "cancelled",
]);

export interface CliHttpExecutorOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly stdout?: Pick<NodeJS.WriteStream, "write">;
  readonly stdin?: NodeJS.ReadStream;
  readonly readFileText?: (path: string) => Promise<string>;
  readonly readStdinText?: () => Promise<string>;
  readonly confirmRemoteDeletion?: (name: string) => Promise<boolean>;
  readonly runPollIntervalMs?: number;
}

export class CliHttpError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number | null = null,
    public readonly code: string | null = null,
    public readonly payload: unknown = null,
    public readonly jsonOutput = false,
  ) {
    super(message);
    this.name = "CliHttpError";
  }

  public formatForStderr(): string {
    if (!this.jsonOutput) {
      return this.message;
    }
    const payload =
      this.payload ?? {
        error: {
          code: this.code ?? "client_error",
          message: this.message,
          ...(this.statusCode === null ? {} : { statusCode: this.statusCode }),
        },
      };
    return JSON.stringify(payload, null, 2);
  }
}

export function parseDuration(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MILLISECONDS;
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value.trim());
  if (match === null) {
    throw new Error(`Invalid timeout duration '${value}'`);
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "ms";
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : 3_600_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`Invalid timeout duration '${value}'`);
  }
  return milliseconds;
}

function url(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function endpoint(command: CliCommand): string {
  switch (command.kind) {
    case "health":
      return "/v1/health";
    case "doctor":
      return "/v1/doctor";
    case "browser-status":
      return "/v1/browser/status";
    case "threads":
      return `/v1/threads${command.includeDeleted ? "?include_deleted=true" : ""}`;
    case "new":
      return "/v1/threads";
    case "chat":
      return `/v1/threads/${encodeURIComponent(command.name)}/messages`;
    case "info":
      return `/v1/threads/${encodeURIComponent(command.name)}`;
    case "run":
      return `/v1/runs/${encodeURIComponent(command.runId)}`;
    case "delete":
      return `/v1/threads/${encodeURIComponent(command.name)}`;
  }
}

function method(command: CliCommand): string {
  switch (command.kind) {
    case "new":
    case "chat":
      return "POST";
    case "delete":
      return "DELETE";
    default:
      return "GET";
  }
}

function isMutation(command: CliCommand): command is Extract<
  CliCommand,
  { readonly kind: "new" | "chat" | "delete" }
> {
  return ["new", "chat", "delete"].includes(command.kind);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TimeoutError") {
    return true;
  }
  const cause = "cause" in error ? error.cause : undefined;
  return cause === undefined ? false : isTimeoutError(cause);
}

function runIsTerminal(payload: unknown): boolean {
  const root = asRecord(payload);
  const run = asRecord(root?.run);
  return typeof run?.state === "string" && TERMINAL_RUN_STATES.has(run.state);
}

function runIdFromPayload(payload: unknown): string | null {
  const run = asRecord(asRecord(payload)?.run);
  return typeof run?.id === "string" ? run.id : null;
}

async function readStream(stream: NodeJS.ReadStream): Promise<string> {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
  }
  return text;
}

export class HttpCliExecutor implements CliCommandExecutor {
  private readonly fetchImplementation: typeof fetch;
  private readonly stdout: Pick<NodeJS.WriteStream, "write">;
  private readonly stdin: NodeJS.ReadStream;
  private readonly readFileText: (path: string) => Promise<string>;
  private readonly readStdinText: () => Promise<string>;
  private readonly confirmRemoteDeletion: (name: string) => Promise<boolean>;
  private readonly runPollIntervalMs: number;

  public constructor(options: CliHttpExecutorOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.stdout = options.stdout ?? process.stdout;
    this.stdin = options.stdin ?? process.stdin;
    this.readFileText = options.readFileText ?? ((path) => readFile(path, "utf8"));
    this.readStdinText = options.readStdinText ?? (() => readStream(this.stdin));
    this.confirmRemoteDeletion =
      options.confirmRemoteDeletion ?? ((name) => this.confirmInteractively(name));
    this.runPollIntervalMs =
      options.runPollIntervalMs ?? RUN_POLL_INTERVAL_MILLISECONDS;
  }

  public async execute(invocation: CliInvocation): Promise<void> {
    const command = invocation.command;
    if (command.kind === "delete" && command.remote && !command.yes) {
      const confirmed = await this.confirmRemoteDeletion(command.name);
      if (!confirmed) {
        throw new Error("Remote deletion cancelled");
      }
    }

    const body = await this.requestBody(command);
    const headers = new Headers({ accept: "application/json" });
    if (invocation.options.apiToken !== undefined) {
      headers.set("authorization", `Bearer ${invocation.options.apiToken}`);
    }
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (isMutation(command)) {
      headers.set("idempotency-key", command.idempotencyKey ?? randomUUID());
    }

    const timeoutMs = parseDuration(invocation.options.timeout);
    const deadline = Date.now() + timeoutMs;
    let activeRunId: string | null = command.kind === "run" ? command.runId : null;
    try {
      let payload = await this.performRequest(
        invocation,
        command,
        headers,
        body,
        Math.max(1, deadline - Date.now()),
      );

      let renderedCommand = command;
      if (
        (command.kind === "new" || command.kind === "chat") &&
        command.wait
      ) {
        activeRunId = runIdFromPayload(payload);
        if (activeRunId === null) {
          throw new CliHttpError(
            "Server accepted the task without returning a run ID",
            null,
            "missing_run_id",
            payload,
            invocation.options.json,
          );
        }
        renderedCommand = { kind: "run", runId: activeRunId, wait: true };
      }

      while (
        renderedCommand.kind === "run" &&
        renderedCommand.wait &&
        !runIsTerminal(payload)
      ) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new CliHttpError(
            `Timed out after ${timeoutMs} ms while waiting for run '${renderedCommand.runId}'`,
            null,
            "client_timeout",
            null,
            invocation.options.json,
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(this.runPollIntervalMs, remainingMs)),
        );
        payload = await this.performRequest(
          invocation,
          renderedCommand,
          this.statusHeaders(invocation),
          undefined,
          Math.max(1, deadline - Date.now()),
        );
      }

      this.render(renderedCommand, payload, invocation.options.json);
    } catch (error) {
      if (!(error instanceof CliHttpError) || error.code !== "client_timeout") {
        throw error;
      }
      throw await this.enrichTimeoutError(
        invocation,
        command,
        headers,
        timeoutMs,
        activeRunId,
      );
    }
  }

  private statusHeaders(invocation: CliInvocation): Headers {
    const headers = new Headers({ accept: "application/json" });
    if (invocation.options.apiToken !== undefined) {
      headers.set("authorization", `Bearer ${invocation.options.apiToken}`);
    }
    return headers;
  }

  private async enrichTimeoutError(
    invocation: CliInvocation,
    command: CliCommand,
    headers: Headers,
    timeoutMs: number,
    knownRunId: string | null,
  ): Promise<CliHttpError> {
    const runId =
      knownRunId !== null
        ? knownRunId
        : await this.recoverPendingRunId(invocation, command, headers);
    const baseMessage =
      `Request timed out after ${timeoutMs} ms; the server may still be processing the run`;
    if (runId === null) {
      return new CliHttpError(
        `${baseMessage}. Check the thread with 'pnpm cli info <thread-name>' for more information`,
        null,
        "client_timeout",
        null,
        invocation.options.json,
      );
    }

    const recoveryCommand = `pnpm cli run ${runId} --wait`;
    const message =
      `${baseMessage} '${runId}'. Check that run for more information with: ${recoveryCommand}`;
    return new CliHttpError(
      message,
      null,
      "client_timeout",
      {
        error: {
          code: "client_timeout",
          message,
          details: { runId, recoveryCommand },
        },
      },
      invocation.options.json,
    );
  }

  private async recoverPendingRunId(
    invocation: CliInvocation,
    command: CliCommand,
    headers: Headers,
  ): Promise<string | null> {
    if (
      command.kind !== "new" &&
      command.kind !== "chat" &&
      command.kind !== "delete"
    ) {
      return null;
    }

    try {
      const response = await this.fetchImplementation(
        url(
          invocation.options.serverUrl,
          `/v1/threads/${encodeURIComponent(command.name)}`,
        ),
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as unknown;
      const pendingRun = asRecord(asRecord(payload)?.pendingRun);
      return typeof pendingRun?.id === "string" ? pendingRun.id : null;
    } catch {
      return null;
    }
  }

  private async performRequest(
    invocation: CliInvocation,
    command: CliCommand,
    headers: Headers,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const requestOptions: RequestInit = {
      method: method(command),
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await this.fetchImplementation(
        url(invocation.options.serverUrl, endpoint(command)),
        requestOptions,
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new CliHttpError(
          `Request timed out after ${timeoutMs} ms; the server may still be processing the run`,
          null,
          "client_timeout",
          null,
          invocation.options.json,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliHttpError(
        `Unable to reach the server: ${message}`,
        null,
        "connection_failed",
        null,
        invocation.options.json,
      );
    }

    const responseText = await response.text();
    let payload: unknown = null;
    if (responseText.length > 0) {
      try {
        payload = JSON.parse(responseText) as unknown;
      } catch {
        throw new CliHttpError(
          `Server returned non-JSON content (${response.status})`,
          response.status,
          null,
          null,
          invocation.options.json,
        );
      }
    }

    if (!response.ok) {
      const root = asRecord(payload);
      const error = asRecord(root?.error);
      const message =
        typeof error?.message === "string"
          ? error.message
          : `Request failed with HTTP ${response.status}`;
      const code = typeof error?.code === "string" ? error.code : null;
      throw new CliHttpError(
        message,
        response.status,
        code,
        payload,
        invocation.options.json,
      );
    }
    return payload;
  }

  private async requestBody(command: CliCommand): Promise<unknown> {
    switch (command.kind) {
      case "new":
        return {
          name: command.name,
          message: await this.resolvePrompt(command.input),
          ...(command.thinking === undefined ? {} : { thinking: command.thinking }),
          wait: false,
        };
      case "chat":
        return {
          message: await this.resolvePrompt(command.input),
          ...(command.thinking === undefined ? {} : { thinking: command.thinking }),
          wait: false,
        };
      case "delete":
        return { delete_remote: command.remote, wait: command.wait };
      default:
        return undefined;
    }
  }

  private resolvePrompt(input: PromptInput): Promise<string> {
    switch (input.kind) {
      case "message":
        return Promise.resolve(input.value);
      case "file":
        return this.readFileText(input.value);
      case "stdin":
        return this.readStdinText();
    }
  }

  private render(command: CliCommand, payload: unknown, json: boolean): void {
    if (json) {
      this.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }

    const root = asRecord(payload);
    if (command.kind === "health") {
      this.stdout.write(`ok (${stringValue(root?.version)})\n`);
      return;
    }
    if (command.kind === "doctor") {
      this.stdout.write(
        `Operational status: ${stringValue(root?.status)} (${stringValue(root?.version)})\n`,
      );
      const checks = Array.isArray(root?.checks) ? root.checks : [];
      for (const value of checks) {
        const diagnostic = asRecord(value);
        const status = stringValue(diagnostic?.status).toUpperCase();
        this.stdout.write(
          `[${status}] ${stringValue(diagnostic?.summary)}\n`,
        );
        if (typeof diagnostic?.detail === "string") {
          this.stdout.write(`  ${diagnostic.detail}\n`);
        }
        if (typeof diagnostic?.remediation === "string") {
          this.stdout.write(`  Action: ${diagnostic.remediation}\n`);
        }
      }
      return;
    }
    if (command.kind === "browser-status") {
      const detail = typeof root?.detail === "string" ? `: ${root.detail}` : "";
      this.stdout.write(`${stringValue(root?.status)}${detail}\n`);
      return;
    }
    if (command.kind === "threads") {
      const threads = Array.isArray(root?.threads) ? root.threads : [];
      if (threads.length === 0) {
        this.stdout.write("No threads.\n");
        return;
      }
      for (const value of threads) {
        const thread = asRecord(value);
        this.stdout.write(
          `${stringValue(thread?.name)}\t${stringValue(thread?.state)}\n`,
        );
      }
      return;
    }

    const run = asRecord(root?.run);
    const thread = asRecord(root?.thread);
    if (run !== null) {
      this.stdout.write(
        `Run ${stringValue(run.id)}: ${stringValue(run.state)}\n`,
      );
      if (typeof run.finalResponse === "string") {
        this.stdout.write(`${run.finalResponse}\n`);
      }
      if (typeof run.errorMessage === "string") {
        this.stdout.write(`Error: ${run.errorMessage}\n`);
      }
    }
    if (thread !== null && command.kind === "info") {
      this.stdout.write(
        `${stringValue(thread.name, command.name)}: ${stringValue(thread.state)}\n`,
      );
      const pendingRun = asRecord(root?.pendingRun);
      if (pendingRun !== null) {
        this.stdout.write(
          `Pending run ${stringValue(pendingRun.id)}: ${stringValue(pendingRun.state)} (${stringValue(pendingRun.phase)})\n`,
        );
      }
    } else if (run === null) {
      this.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    }
  }

  private async confirmInteractively(name: string): Promise<boolean> {
    if (!this.stdin.isTTY || !("isTTY" in this.stdout) || !this.stdout.isTTY) {
      throw new Error(
        "Remote deletion requires --yes when the CLI is not interactive",
      );
    }

    const readline = createInterface({ input: this.stdin, output: process.stdout });
    try {
      const answer = await readline.question(
        `Delete the remote ChatGPT conversation for '${name}'? [y/N] `,
      );
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      readline.close();
    }
  }
}
