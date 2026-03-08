import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord } from '../shared/types.js';
import { JobRecordSchema } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { readJsonFile, writeJsonAtomic } from './fs-utils.js';

export class JobStore {
  constructor(private readonly config: RuntimeConfig) {}

  async save(record: JobRecord): Promise<void> {
    const recordPath = path.join(this.config.jobsDir, record.id, 'job.json');
    await writeJsonAtomic(recordPath, record);
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const recordPath = path.join(this.config.jobsDir, jobId, 'job.json');
    const raw = await readJsonFile<JobRecord>(recordPath);
    if (!raw) {
      return null;
    }
    const normalized = normalizeLegacyJobRecord(raw);
    const parsed = JobRecordSchema.parse(normalized.record);
    if (normalized.changed) {
      await this.save(parsed);
    }
    return parsed;
  }

  async list(): Promise<JobRecord[]> {
    const items = await readdir(this.config.jobsDir, { withFileTypes: true }).catch(() => []);
    const records = await Promise.all(
      items
        .filter((item) => item.isDirectory())
        .map(async (item) => {
          try {
            return await this.get(item.name);
          } catch {
            return null;
          }
        })
    );
    return records
      .filter((record): record is JobRecord => Boolean(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

function normalizeLegacyJobRecord(raw: unknown): { record: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { record: raw, changed: false };
  }

  const record = raw as Record<string, unknown>;
  const artifacts = record.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return { record: raw, changed: false };
  }

  const artifactRecord = artifacts as Record<string, unknown>;
  if (typeof artifactRecord.debugLogPath === 'string' && artifactRecord.debugLogPath.length > 0) {
    return { record: raw, changed: false };
  }

  if (typeof artifactRecord.logPath !== 'string' || artifactRecord.logPath.length === 0) {
    return { record: raw, changed: false };
  }

  return {
    changed: true,
    record: {
      ...record,
      artifacts: {
        ...artifactRecord,
        debugLogPath: path.join(path.dirname(artifactRecord.logPath), 'debug.log'),
      },
    },
  };
}
