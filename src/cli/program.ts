import { Command, InvalidArgumentError, Option } from "commander";

import { APP_VERSION } from "../version.js";
import type {
  CliCommandExecutor,
  CliGlobalOptions,
  CliInvocation,
  CliThinkingLevel,
  PromptInput,
} from "./contracts.js";

interface PromptOptions {
  readonly message?: string;
  readonly file?: string;
  readonly stdin?: boolean;
  readonly wait: boolean;
  readonly idempotencyKey?: string;
  readonly thinking?: CliThinkingLevel;
}

interface DeleteOptions {
  readonly remote: boolean;
  readonly yes: boolean;
  readonly wait: boolean;
  readonly idempotencyKey?: string;
}

function resolvePromptInput(options: PromptOptions): PromptInput {
  const candidates: PromptInput[] = [];

  if (options.message !== undefined) {
    candidates.push({ kind: "message", value: options.message });
  }

  if (options.file !== undefined) {
    candidates.push({ kind: "file", value: options.file });
  }

  if (options.stdin === true) {
    candidates.push({ kind: "stdin" });
  }

  const [candidate] = candidates;
  if (candidates.length !== 1 || candidate === undefined) {
    throw new InvalidArgumentError(
      "Exactly one of --message, --file, or --stdin is required",
    );
  }

  return candidate;
}

function addPromptOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--message <text>", "use prompt text directly").conflicts([
        "file",
        "stdin",
      ]),
    )
    .addOption(
      new Option("--file <path>", "read prompt text from a file").conflicts([
        "message",
        "stdin",
      ]),
    )
    .addOption(
      new Option("--stdin", "read prompt text from standard input").conflicts([
        "message",
        "file",
      ]),
    )
    .option("--no-wait", "return after the durable run is queued")
    .addOption(
      new Option("--thinking <level>", "thinking level")
        .choices(["instant", "medium", "high"]),
    )
    .option("--idempotency-key <key>", "supply an explicit idempotency key");
}

function globalOptions(command: Command): CliGlobalOptions {
  const options = command.optsWithGlobals<{
    serverUrl?: string;
    apiToken?: string;
    json?: boolean;
    timeout?: string;
  }>();

  return {
    serverUrl: options.serverUrl ?? "http://127.0.0.1:7421",
    apiToken: options.apiToken,
    json: options.json ?? false,
    timeout: options.timeout,
  };
}

async function execute(
  executor: CliCommandExecutor,
  command: Command,
  invocation: CliInvocation["command"],
): Promise<void> {
  await executor.execute({
    command: invocation,
    options: globalOptions(command),
  });
}

export function createCliProgram(executor: CliCommandExecutor): Command {
  const program = new Command("cgpt")
    .description("Control the local ChatGPT Playwright proxy")
    .version(APP_VERSION)
    .option(
      "--server-url <url>",
      "proxy base URL",
      process.env.CHATGPT_PROXY_URL ?? "http://127.0.0.1:7421",
    )
    .option(
      "--api-token <token>",
      "proxy bearer token when server authentication is enabled",
      process.env.CHATGPT_PROXY_TOKEN,
    )
    .option("--json", "emit machine-readable JSON")
    .option("--timeout <duration>", "client-side request timeout")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("health")
    .description("check service health")
    .action(async (_options: unknown, command: Command) => {
      await execute(executor, command, { kind: "health" });
    });

  program
    .command("doctor")
    .description("inspect operational readiness and remediation guidance")
    .action(async (_options: unknown, command: Command) => {
      await execute(executor, command, { kind: "doctor" });
    });

  program
    .command("browser-status")
    .description("show browser and login status")
    .action(async (_options: unknown, command: Command) => {
      await execute(executor, command, { kind: "browser-status" });
    });

  program
    .command("threads")
    .description("list local threads")
    .option("--include-deleted", "include tombstoned threads")
    .action(
      async (
        options: { readonly includeDeleted?: boolean },
        command: Command,
      ) => {
        await execute(executor, command, {
          kind: "threads",
          includeDeleted: options.includeDeleted ?? false,
        });
      },
    );

  addPromptOptions(
    program.command("new <name>").description("create a named thread"),
  ).action(async (name: string, options: PromptOptions, command: Command) => {
    await execute(executor, command, {
      kind: "new",
      name,
      input: resolvePromptInput(options),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      wait: options.wait,
      idempotencyKey: options.idempotencyKey,
    });
  });

  addPromptOptions(
    program
      .command("chat <name>")
      .description("send a message to an existing named thread"),
  ).action(async (name: string, options: PromptOptions, command: Command) => {
    await execute(executor, command, {
      kind: "chat",
      name,
      input: resolvePromptInput(options),
      ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
      wait: options.wait,
      idempotencyKey: options.idempotencyKey,
    });
  });

  program
    .command("info <name>")
    .description("show local thread information")
    .action(async (name: string, _options: unknown, command: Command) => {
      await execute(executor, command, { kind: "info", name });
    });

  program
    .command("run <run-id>")
    .description("show durable run status")
    .action(async (runId: string, _options: unknown, command: Command) => {
      await execute(executor, command, { kind: "run", runId });
    });

  program
    .command("delete <name>")
    .description("delete a local thread mapping")
    .option("--remote", "also request remote ChatGPT deletion")
    .option("--yes", "skip interactive remote-deletion confirmation")
    .option("--no-wait", "return after the durable deletion run is queued")
    .option("--idempotency-key <key>", "supply an explicit idempotency key")
    .action(async (name: string, options: DeleteOptions, command: Command) => {
      await execute(executor, command, {
        kind: "delete",
        name,
        remote: options.remote,
        yes: options.yes,
        wait: options.wait,
        idempotencyKey: options.idempotencyKey,
      });
    });

  return program;
}

export async function runCli(
  arguments_: readonly string[],
  executor: CliCommandExecutor,
): Promise<void> {
  const program = createCliProgram(executor);

  if (arguments_.length === 0) {
    program.outputHelp();
    return;
  }

  await program.parseAsync([...arguments_], { from: "user" });
}
