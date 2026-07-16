import {
  chmodSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { applyMigrations } from "./migrations.js";

export type TimestampProvider = () => string;

export interface OpenDatabaseOptions {
  readonly now?: TimestampProvider;
}

export interface OpenedDatabase {
  readonly database: Database.Database;
  readonly now: TimestampProvider;
}

function systemTimestamp(): string {
  return new Date().toISOString();
}

function prepareDatabasePath(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  const parentDirectory = dirname(databasePath);
  const parentExisted = existsSync(parentDirectory);
  mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
  if (!parentExisted) {
    chmodSync(parentDirectory, 0o700);
  }
}

export function openDatabase(
  databasePath: string,
  options: OpenDatabaseOptions = {},
): OpenedDatabase {
  const now = options.now ?? systemTimestamp;
  prepareDatabasePath(databasePath);

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("journal_mode = WAL");

  applyMigrations(database, now);

  if (databasePath !== ":memory:") {
    chmodSync(databasePath, 0o600);
  }

  return { database, now };
}
