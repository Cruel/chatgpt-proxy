import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function expandHomePath(value: string, homeDirectory: string): string {
  if (value === "~") {
    return homeDirectory;
  }

  if (value.startsWith("~/")) {
    return join(homeDirectory, value.slice(2));
  }

  return value
    .replaceAll("${HOME}", homeDirectory)
    .replaceAll("$HOME", homeDirectory);
}

function resolvedPathSchema(
  homeDirectory: string,
  baseDirectory: string,
  defaultValue: string,
) {
  return z
    .string()
    .min(1)
    .transform((value) => {
      const expanded = expandHomePath(value, homeDirectory);
      return isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded);
    })
    .default(defaultValue);
}

function validateChatGptUrl(value: string, context: z.RefinementCtx): void {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Must be a valid URL",
    });
    return;
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") {
    context.addIssue({
      code: "custom",
      message: "Must use an https://chatgpt.com/ URL",
    });
  }
}

const chatGptUrlSchema = z
  .string()
  .min(1)
  .superRefine(validateChatGptUrl)
  .transform((value) => new URL(value).toString());

export function createConfigSchema(
  homeDirectory: string,
  baseDirectory: string,
) {
  const defaultProfileDirectory = join(baseDirectory, ".playwright-profile");
  const defaultDatabasePath = join(baseDirectory, "state.sqlite3");
  const defaultArtifactDirectory = join(baseDirectory, ".artifacts");

  return z
    .strictObject({
      server: z
        .strictObject({
          listen_host: z
            .string()
            .min(1)
            .default("127.0.0.1")
            .refine((value) => LOOPBACK_HOSTS.has(value), {
              message: "Only loopback listen hosts are supported",
            }),
          listen_port: z.number().int().min(1).max(65_535).default(7421),
          api_token: z.string().min(1),
        })
        .transform((value) => ({
          listenHost: value.listen_host,
          listenPort: value.listen_port,
          apiToken: value.api_token,
        })),
      chatgpt: z
        .strictObject({
          project_name: z.string().trim().min(1),
          project_url: chatGptUrlSchema,
          profile_dir: resolvedPathSchema(
            homeDirectory,
            baseDirectory,
            defaultProfileDirectory,
          ),
          headless: z.boolean().default(false),
          delete_remote_thread: z.boolean().default(false),
        })
        .transform((value) => ({
          projectName: value.project_name,
          projectUrl: value.project_url,
          profileDirectory: value.profile_dir,
          headless: value.headless,
          deleteRemoteThread: value.delete_remote_thread,
        })),
      browser: z
        .strictObject({
          max_concurrent_runs: z.number().int().min(1).max(16).default(3),
          page_idle_timeout_seconds: z.number().int().positive().default(300),
          navigation_timeout_seconds: z.number().int().positive().default(45),
          response_timeout_seconds: z.number().int().positive().default(1_800),
        })
        .prefault({})
        .transform((value) => ({
          maxConcurrentRuns: value.max_concurrent_runs,
          pageIdleTimeoutSeconds: value.page_idle_timeout_seconds,
          navigationTimeoutSeconds: value.navigation_timeout_seconds,
          responseTimeoutSeconds: value.response_timeout_seconds,
        })),
      limits: z
        .strictObject({
          max_input_chars: z.number().int().positive().default(100_000),
          max_input_bytes: z.number().int().positive().default(262_144),
          max_queue_depth: z.number().int().positive().default(20),
        })
        .prefault({})
        .transform((value) => ({
          maxInputCharacters: value.max_input_chars,
          maxInputBytes: value.max_input_bytes,
          maxQueueDepth: value.max_queue_depth,
        })),
      database: z
        .strictObject({
          path: resolvedPathSchema(
            homeDirectory,
            baseDirectory,
            defaultDatabasePath,
          ),
        })
        .prefault({})
        .transform((value) => ({ path: value.path })),
      diagnostics: z
        .strictObject({
          artifact_dir: resolvedPathSchema(
            homeDirectory,
            baseDirectory,
            defaultArtifactDirectory,
          ),
          capture_screenshot_on_error: z.boolean().default(true),
          capture_html_on_error: z.boolean().default(true),
          capture_trace_on_error: z.boolean().default(true),
          retain_days: z.number().int().min(0).default(30),
        })
        .prefault({})
        .transform((value) => ({
          artifactDirectory: value.artifact_dir,
          captureScreenshotOnError: value.capture_screenshot_on_error,
          captureHtmlOnError: value.capture_html_on_error,
          captureTraceOnError: value.capture_trace_on_error,
          retainDays: value.retain_days,
        })),
      live_tests: z
        .strictObject({
          enabled: z.boolean().default(false),
          project_url: z
            .string()
            .default("")
            .superRefine((value, context) => {
              if (value !== "") {
                validateChatGptUrl(value, context);
              }
            })
            .transform((value) =>
              value === "" ? value : new URL(value).toString(),
            ),
          thread_prefix: z.string().trim().min(1).default("chatgpt-proxy-e2e"),
          allow_remote_deletion: z.boolean().default(false),
        })
        .prefault({})
        .transform((value) => ({
          enabled: value.enabled,
          projectUrl: value.project_url,
          threadPrefix: value.thread_prefix,
          allowRemoteDeletion: value.allow_remote_deletion,
        })),
    })
    .superRefine((value, context) => {
      if (/^\/mnt\/[a-z](?:\/|$)/i.test(value.chatgpt.profileDirectory)) {
        context.addIssue({
          code: "custom",
          path: ["chatgpt", "profile_dir"],
          message:
            "The persistent browser profile must use the WSL filesystem, not a mounted Windows drive",
        });
      }
      if (value.live_tests.enabled && value.live_tests.projectUrl === "") {
        context.addIssue({
          code: "custom",
          path: ["live_tests", "project_url"],
          message: "A live-test project URL is required when live tests are enabled",
        });
      }
    })
    .transform((value) => ({
      server: value.server,
      chatGpt: value.chatgpt,
      browser: value.browser,
      limits: value.limits,
      database: value.database,
      diagnostics: value.diagnostics,
      liveTests: value.live_tests,
    }));
}

export type AppConfig = z.output<ReturnType<typeof createConfigSchema>>;
