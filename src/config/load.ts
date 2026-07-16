import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";
import { ZodError } from "zod";

import { createConfigSchema, type AppConfig } from "./schema.js";

export interface ConfigParseOptions {
  readonly homeDirectory?: string;
  readonly baseDirectory?: string;
}

export class ConfigError extends Error {
  public override readonly cause: unknown;

  public constructor(
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ConfigError";
    this.cause = cause;
  }
}

export function parseConfigObject(
  input: unknown,
  options: ConfigParseOptions = {},
): AppConfig {
  const schema = createConfigSchema(
    options.homeDirectory ?? homedir(),
    options.baseDirectory ?? process.cwd(),
  );

  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(`Invalid configuration: ${error.message}`, error);
    }

    throw error;
  }
}

export function parseConfigText(
  text: string,
  options: ConfigParseOptions = {},
): AppConfig {
  let parsed: unknown;

  try {
    parsed = parseToml(text);
  } catch (error) {
    throw new ConfigError("Configuration is not valid TOML", error);
  }

  return parseConfigObject(parsed, options);
}

export async function loadConfig(
  configPath: string,
  options: ConfigParseOptions = {},
): Promise<AppConfig> {
  const resolvedConfigPath = resolve(configPath);
  let text: string;

  try {
    text = await readFile(resolvedConfigPath, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Unable to read configuration at ${resolvedConfigPath}`,
      error,
    );
  }

  return parseConfigText(text, {
    ...options,
    baseDirectory: options.baseDirectory ?? dirname(resolvedConfigPath),
  });
}
