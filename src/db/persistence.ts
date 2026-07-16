import type Database from "better-sqlite3";

import {
  openDatabase,
  type OpenDatabaseOptions,
  type TimestampProvider,
} from "./connection.js";
import { ArtifactRepository } from "./artifact-repository.js";
import { RunEventRepository } from "./run-event-repository.js";
import { RunRepository } from "./run-repository.js";
import { ThreadRepository } from "./thread-repository.js";

export class Persistence {
  public readonly threads: ThreadRepository;
  public readonly runs: RunRepository;
  public readonly runEvents: RunEventRepository;
  public readonly artifacts: ArtifactRepository;

  public constructor(
    public readonly database: Database.Database,
    public readonly now: TimestampProvider,
  ) {
    this.threads = new ThreadRepository(database, now);
    this.runs = new RunRepository(database, now);
    this.runEvents = new RunEventRepository(database, now);
    this.artifacts = new ArtifactRepository(database, now);
  }

  public transaction<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }

  public close(): void {
    this.database.close();
  }
}

export function openPersistence(
  databasePath: string,
  options: OpenDatabaseOptions = {},
): Persistence {
  const opened = openDatabase(databasePath, options);
  return new Persistence(opened.database, opened.now);
}
