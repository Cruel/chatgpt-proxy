import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdirSync,
  rmSync,
  writeFile,
} from "node:fs";
import { promisify } from "node:util";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { DiagnosticArtifactDraft } from "../browser/adapter.js";
import type { Persistence } from "../db/persistence.js";
import type { ArtifactRecord } from "../domain/models.js";

const mkdirAsync = promisify(mkdir);
const writeFileAsync = promisify(writeFile);

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized.length === 0 ? "unknown" : normalized.slice(0, 80);
}

function safeExtension(value: string): string {
  const normalized = value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return normalized.length === 0 ? "bin" : normalized.slice(0, 12);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface DiagnosticArtifactStoreOptions {
  readonly artifactDirectory: string;
  readonly persistence: Persistence;
  readonly retainDays: number;
  readonly now?: () => Date;
}

export class DiagnosticArtifactStore {
  private readonly artifactDirectory: string;
  private readonly persistence: Persistence;
  private readonly retainDays: number;
  private readonly now: () => Date;

  public constructor(options: DiagnosticArtifactStoreOptions) {
    this.artifactDirectory = resolve(options.artifactDirectory);
    this.persistence = options.persistence;
    this.retainDays = options.retainDays;
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.artifactDirectory, { recursive: true, mode: 0o700 });
  }

  public async persist(
    runId: string,
    phase: string,
    drafts: readonly DiagnosticArtifactDraft[],
  ): Promise<readonly ArtifactRecord[]> {
    if (drafts.length === 0) {
      return [];
    }

    const runDirectory = join(this.artifactDirectory, safeSegment(runId));
    await mkdirAsync(runDirectory, { recursive: true, mode: 0o700 });
    const timestamp = this.now().toISOString().replaceAll(/[:.]/g, "-");
    const records: ArtifactRecord[] = [];

    for (const draft of drafts) {
      const id = randomUUID();
      const extension = safeExtension(draft.suggestedExtension);
      const filename = [
        timestamp,
        safeSegment(phase),
        safeSegment(draft.type),
        id,
      ].join("-") + `.${extension}`;
      const path = join(runDirectory, filename);
      await writeFileAsync(path, draft.data, { mode: 0o600, flag: "wx" });
      const sha256 = createHash("sha256").update(draft.data).digest("hex");
      try {
        records.push(this.persistence.artifacts.create({
          id,
          runId,
          artifactType: draft.type,
          path,
          sha256,
          sizeBytes: draft.data.byteLength,
        }));
      } catch (error) {
        rmSync(path, { force: true });
        throw error;
      }
    }
    return records;
  }

  public pruneExpired(): number {
    const cutoff = new Date(
      this.now().getTime() - this.retainDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const expired = this.persistence.artifacts.listCreatedBefore(cutoff);
    for (const artifact of expired) {
      const artifactPath = resolve(artifact.path);
      if (isWithin(this.artifactDirectory, artifactPath)) {
        rmSync(artifactPath, { force: true });
        const parent = dirname(artifactPath);
        if (parent !== this.artifactDirectory && extname(parent) === "") {
          try {
            rmSync(parent, { recursive: false });
          } catch {
            // The run directory still contains retained artifacts.
          }
        }
      }
      this.persistence.artifacts.deleteById(artifact.id);
    }
    return expired.length;
  }
}
