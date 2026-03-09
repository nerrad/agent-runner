import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { writeJsonAtomic } from './fs-utils.js';

export interface BrokerLease {
  jobId: string;
  token: string;
  repoUrl: string;
  profile: JobRecord['spec']['capabilityProfile'];
  branchName: string;
  expiresAt: string;
}

export class BrokerLeaseStore {
  constructor(private readonly config: RuntimeConfig) {}

  async issue(record: JobRecord): Promise<BrokerLease> {
    const lease: BrokerLease = {
      jobId: record.id,
      token: crypto.randomUUID(),
      repoUrl: record.spec.repoUrl,
      profile: record.spec.capabilityProfile,
      branchName: record.branchName,
      expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
    };
    await writeJsonAtomic(this.pathFor(record.id), lease);
    return lease;
  }

  async get(jobId: string): Promise<BrokerLease | null> {
    try {
      const raw = await readFile(this.pathFor(jobId), 'utf8');
      return JSON.parse(raw) as BrokerLease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async validate(jobId: string, token: string): Promise<BrokerLease> {
    const lease = await this.get(jobId);
    if (!lease || lease.token !== token) {
      throw new Error('Invalid broker lease');
    }
    if (Date.parse(lease.expiresAt) < Date.now()) {
      throw new Error('Expired broker lease');
    }
    return lease;
  }

  private pathFor(jobId: string): string {
    return path.join(this.config.jobsDir, jobId, 'broker-lease.json');
  }
}
