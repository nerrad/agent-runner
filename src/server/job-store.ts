import { existsSync } from 'node:fs';
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
    const normalized = await normalizeLegacyJobRecord(raw);
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

async function normalizeLegacyJobRecord(raw: unknown): Promise<{ record: unknown; changed: boolean }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { record: raw, changed: false };
  }

  const record = raw as Record<string, unknown>;
  const artifacts = record.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return { record: raw, changed: false };
  }

  const artifactRecord = artifacts as Record<string, unknown>;
  const hasDebugLogPath = typeof artifactRecord.debugLogPath === 'string' && artifactRecord.debugLogPath.length > 0;
  const hasProgressEventsPath = typeof artifactRecord.progressEventsPath === 'string'
    && artifactRecord.progressEventsPath.length > 0;
  const hasSecurityAuditPath = typeof artifactRecord.securityAuditPath === 'string'
    && artifactRecord.securityAuditPath.length > 0;
  const hasInputsDir = typeof artifactRecord.inputsDir === 'string' && artifactRecord.inputsDir.length > 0;
  const hasOutputsDir = typeof artifactRecord.outputsDir === 'string' && artifactRecord.outputsDir.length > 0;
  const hasBrokerEnvPath = typeof artifactRecord.brokerEnvPath === 'string' && artifactRecord.brokerEnvPath.length > 0;
  const hasAgentStateSummaryPath = typeof artifactRecord.agentStateSummaryPath === 'string'
    && artifactRecord.agentStateSummaryPath.length > 0;
  const hasAgentStateDiffPath = typeof artifactRecord.agentStateDiffPath === 'string'
    && artifactRecord.agentStateDiffPath.length > 0;

  if (
    hasDebugLogPath
    && hasProgressEventsPath
    && hasSecurityAuditPath
    && hasInputsDir
    && hasOutputsDir
    && hasBrokerEnvPath
    && hasAgentStateSummaryPath
    && hasAgentStateDiffPath
  ) {
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
        securityAuditPath: path.join(path.dirname(artifactRecord.logPath), 'security-audit.jsonl'),
        debugLogPath: hasDebugLogPath
          ? preserveLegacyPath(artifactRecord.debugLogPath as string, path.join(path.dirname(artifactRecord.logPath), 'outputs', 'debug.log'))
          : path.join(path.dirname(artifactRecord.logPath), 'outputs', 'debug.log'),
        progressEventsPath: hasProgressEventsPath
          ? preserveLegacyPath(artifactRecord.progressEventsPath as string, path.join(path.dirname(artifactRecord.logPath), 'outputs', 'progress.ndjson'))
          : path.join(path.dirname(artifactRecord.logPath), 'outputs', 'progress.ndjson'),
        finalResponsePath: typeof artifactRecord.finalResponsePath === 'string'
          ? preserveLegacyPath(
            artifactRecord.finalResponsePath,
            path.join(path.dirname(artifactRecord.logPath), 'outputs', path.basename(artifactRecord.finalResponsePath)),
          )
          : path.join(path.dirname(artifactRecord.logPath), 'outputs', 'final-response.json'),
        schemaPath: typeof artifactRecord.schemaPath === 'string'
          ? preserveLegacyPath(
            artifactRecord.schemaPath,
            path.join(path.dirname(artifactRecord.logPath), 'inputs', path.basename(artifactRecord.schemaPath)),
          )
          : path.join(path.dirname(artifactRecord.logPath), 'inputs', 'result-schema.json'),
        promptPath: typeof artifactRecord.promptPath === 'string'
          ? preserveLegacyPath(
            artifactRecord.promptPath,
            path.join(path.dirname(artifactRecord.logPath), 'inputs', path.basename(artifactRecord.promptPath)),
          )
          : path.join(path.dirname(artifactRecord.logPath), 'inputs', 'prompt.txt'),
        brokerEnvPath: hasBrokerEnvPath
          ? preserveLegacyPath(
            artifactRecord.brokerEnvPath as string,
            path.join(path.dirname(artifactRecord.logPath), 'inputs', 'broker-env.json'),
          )
          : path.join(path.dirname(artifactRecord.logPath), 'inputs', 'broker-env.json'),
        inputsDir: path.join(path.dirname(artifactRecord.logPath), 'inputs'),
        outputsDir: path.join(path.dirname(artifactRecord.logPath), 'outputs'),
        agentStateSummaryPath: path.join(path.dirname(artifactRecord.logPath), 'agent-state-summary.json'),
        agentStateDiffPath: path.join(path.dirname(artifactRecord.logPath), 'agent-state.diff'),
      },
    },
  };
}

function preserveLegacyPath(legacyPath: string, migratedPath: string): string {
  return existsSync(legacyPath) ? legacyPath : migratedPath;
}
