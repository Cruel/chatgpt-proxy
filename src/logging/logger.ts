import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from "pino";

const REDACTED_PATHS = [
  "apiToken",
  "server.apiToken",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "cookies",
] as const;

export interface CreateLoggerOptions {
  readonly level?: string;
  readonly name?: string;
  readonly base?: Readonly<Record<string, unknown>>;
  readonly destination?: DestinationStream;
}

export type AppLogger = Logger;

export function createLogger(options: CreateLoggerOptions = {}): AppLogger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    name: options.name ?? "chatgpt-proxy",
    base: {
      service: "chatgpt-proxy",
      ...options.base,
    },
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}
