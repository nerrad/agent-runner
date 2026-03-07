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
    return JobRecordSchema.parse(raw);
  }

  async list(): Promise<JobRecord[]> {
    const items = await readdir(this.config.jobsDir, { withFileTypes: true }).catch(() => []);
    const records = await Promise.all(
      items
        .filter((item) => item.isDirectory())
        .map((item) => this.get(item.name))
    );
    return records
      .filter((record): record is JobRecord => Boolean(record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

