import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { writeJsonAtomic } from './fs-utils.js';

export interface BrokerLease {
  jobId: string;
  token: string;
  renameToken: string;
  repoUrl: string;
  profile: JobRecord['spec']['capabilityProfile'];
  branchName: string;
  expiresAt: string;
}

export class BrokerLeaseStore {
  constructor(private readonly config: RuntimeConfig) {}

  async issue(record: JobRecord): Promise<BrokerLease> {
    const token = crypto.randomUUID();
    const isBrokerProfile = record.spec.capabilityProfile === 'repo-broker' || record.spec.capabilityProfile === 'docker-broker';
    const lease: BrokerLease = {
      jobId: record.id,
      token,
      renameToken: isBrokerProfile ? token : crypto.randomUUID(),
      repoUrl: record.spec.repoUrl,
      profile: record.spec.capabilityProfile,
      branchName: record.branchName,
      expiresAt: new Date(Date.now() + (2 * 60 * 60 * 1000)).toISOString(),
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
    if (!lease || !tokensEqual(lease.token, token)) {
      throw new Error('Invalid broker lease');
    }
    if (Date.parse(lease.expiresAt) < Date.now()) {
      throw new Error('Expired broker lease');
    }
    return lease;
  }

  async validateRename(jobId: string, token: string): Promise<BrokerLease> {
    const lease = await this.get(jobId);
    if (!lease || !tokensEqual(lease.renameToken, token)) {
      throw new Error('Invalid broker lease');
    }
    if (Date.parse(lease.expiresAt) < Date.now()) {
      throw new Error('Expired broker lease');
    }
    return lease;
  }

  async revoke(jobId: string): Promise<void> {
    await rm(this.pathFor(jobId), { force: true });
  }

  private pathFor(jobId: string): string {
    return path.join(this.config.jobsDir, jobId, 'broker-lease.json');
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
