import { randomUUID } from 'node:crypto';
import { appendFile, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentResult, JobRecord, JobSpec, JobStatus } from '../shared/types.js';
import { AgentResultSchema, JobSpecSchema } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { createGitHostProfile } from './config.js';
import type { DockerRunner } from './docker-runner.js';
import { ensureDir, pathExists, safeRemove, writeJsonAtomic } from './fs-utils.js';
import type { GitManager } from './git-manager.js';
import { JobEvents } from './job-events.js';
import { launchDetachedJobRunner } from './job-launcher.js';
import { buildJobPaths } from './paths.js';
import { AgentAdapters } from './agent-adapters.js';
import { runCommand } from './process-utils.js';
import { stageSpecBundle } from './spec-resolver.js';
import { JobStore } from './job-store.js';

const TERMINAL_STATUSES = new Set<JobStatus>([ 'blocked', 'completed', 'failed', 'canceled' ]);

export interface JobManagerOptions {
  runMode?: 'inline' | 'process';
  launchJobRunner?: (jobId: string) => Promise<void>;
}

interface JobLockPayload {
  jobId: string;
  pid: number;
}

interface ResolvedRuntimeAuth {
  env: Record<string, string>;
  source: 'env' | 'helper' | 'local-state';
}

interface AuthLoopState {
  authFailureCount: number;
  meaningfulOutputSeen: boolean;
  abortRequested: boolean;
  blockerReason?: string;
}

export class JobManager {
  private readonly activeLockPath: string;
  private readonly runMode: 'inline' | 'process';
  private readonly launchJobRunner: (jobId: string) => Promise<void>;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: JobStore,
    private readonly events: JobEvents,
    private readonly git: GitManager,
    private readonly docker: DockerRunner,
    private readonly adapters: AgentAdapters,
    options: JobManagerOptions = {},
  ) {
    this.activeLockPath = path.join(this.config.appDir, 'active-job.lock');
    this.runMode = options.runMode ?? 'process';
    this.launchJobRunner = options.launchJobRunner ?? ((jobId) => launchDetachedJobRunner(this.config, jobId));
  }

  async createJob(input: JobSpec): Promise<JobRecord> {
    const spec = JobSpecSchema.parse(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const paths = buildJobPaths(this.config, id);
    const branchName = `agent-runner/${id}`;

    await ensureDir(paths.jobDir);
    await ensureDir(path.dirname(paths.workspacePath));
    await ensureDir(paths.artifactDir);

    const record: JobRecord = {
      id,
      spec,
      status: 'queued',
      workspacePath: paths.workspacePath,
      branchName,
      createdAt: now,
      updatedAt: now,
      artifacts: paths.artifacts,
    };

    const authResult = await this.resolveRuntimeAuth(spec.agentRuntime);
    if (!authResult.ok) {
      await writeFile(record.artifacts.logPath, `${authResult.message}\n`, 'utf8');
      const failedRecord: JobRecord = {
        ...record,
        status: 'failed',
        endedAt: now,
        blockerReason: authResult.message,
      };
      await this.store.save(failedRecord);
      this.events.emitRecord(failedRecord);
      return failedRecord;
    }

    await this.store.save(record);
    this.events.emitRecord(record);

    if (this.runMode === 'inline') {
      void this.runJob(record.id);
    } else {
      await this.launchJobRunner(record.id);
    }

    return record;
  }

  async listJobs(): Promise<JobRecord[]> {
    return await this.store.list();
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    return await this.store.get(jobId);
  }

  async cancelJob(jobId: string): Promise<JobRecord | null> {
    const record = await this.store.get(jobId);
    if (!record) {
      return null;
    }

    if (record.containerId) {
      await this.docker.stopJob(record.containerId);
    }

    if (TERMINAL_STATUSES.has(record.status)) {
      return record;
    }

    const canceled = await this.updateRecord(record, {
      status: 'canceled',
      endedAt: new Date().toISOString(),
      blockerReason: 'Canceled by user',
    });
    await this.cleanupActiveLockForJob(jobId);
    return canceled;
  }

  async readLog(jobId: string): Promise<string> {
    const record = await this.getJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }

    try {
      return await readFile(record.artifacts.logPath, 'utf8');
    } catch {
      return '';
    }
  }

  async runJob(jobId: string): Promise<void> {
    const lock = await this.acquireJobSlot(jobId);
    if (!lock) {
      return;
    }

    try {
      const record = await this.requireJob(jobId);
      if (TERMINAL_STATUSES.has(record.status)) {
        return;
      }

      await this.executeJob(jobId);
    } catch (error) {
      const record = await this.store.get(jobId);
      if (record && !TERMINAL_STATUSES.has(record.status)) {
        await this.updateRecord(record, {
          status: 'failed',
          endedAt: new Date().toISOString(),
          blockerReason: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await this.releaseJobSlot(lock);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    let record = await this.requireJob(jobId);
    const profile = createGitHostProfile(this.config, record.spec.githubHost);
    const runtimeAuth = await this.resolveRuntimeAuth(record.spec.agentRuntime);
    const runtimeEnv: Record<string, string> = runtimeAuth.ok ? { ...runtimeAuth.value.env } : {};

    if (profile.proxyUrl) {
      runtimeEnv.HTTPS_PROXY = profile.proxyUrl;
    }

    await writeFile(record.artifacts.logPath, '', 'utf8');
    await writeFile(record.artifacts.agentTranscriptPath, '', 'utf8');

    if (!runtimeAuth.ok) {
      await appendFile(record.artifacts.logPath, `${runtimeAuth.message}\n`, 'utf8');
      await this.updateRecord(record, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        blockerReason: runtimeAuth.message,
      });
      return;
    }

    record = await this.updateRecord(record, {
      status: 'cloning',
      startedAt: new Date().toISOString(),
    });

    await safeRemove(record.workspacePath);
    await ensureDir(path.dirname(record.workspacePath));
    await this.git.cloneRepository(record.spec.repoUrl, record.workspacePath, record.spec.ref);
    await this.git.createBranch(record.workspacePath, record.branchName);
    record = await this.updateRecord(record, {
      headSha: await this.git.getHeadSha(record.workspacePath),
    });

    record = await this.updateRecord(record, {
      status: 'bootstrapping',
    });

    const stagedSpec = await stageSpecBundle(record.workspacePath, record.spec.specPath, record.artifacts.specBundlePath);
    record = await this.updateRecord(record, {
      resolvedSpec: stagedSpec.resolvedSpec,
    });

    const prepared = await this.adapters.prepare(record);
    await this.docker.ensureImageBuilt();

    record = await this.updateRecord(record, {
      status: 'running',
    });

    const authLoopState: AuthLoopState = {
      authFailureCount: 0,
      meaningfulOutputSeen: false,
      abortRequested: false,
    };
    const runtimePolicy = this.adapters.runtimeAuthPolicy(record.spec.agentRuntime);

    const dockerResult = await this.docker.runJob({
      job: record,
      command: prepared.command,
      env: runtimeEnv,
      onStart: async (containerId) => {
        record = await this.updateRecord(record, {
          containerId,
          debugCommand: this.docker.createDebugCommand({ ...record, containerId }),
        });
      },
      onLog: async (chunk) => {
        await appendFile(record.artifacts.logPath, chunk, 'utf8');
        await this.docker.appendTranscript(record.artifacts.agentTranscriptPath, chunk);
        this.events.emitLog({
          jobId: record.id,
          chunk,
          at: new Date().toISOString(),
        });

        await this.observeRuntimeLog(record, chunk, authLoopState);
      },
    });

    const latestRecord = await this.requireJob(record.id);
    if (latestRecord.status === 'canceled') {
      await this.updateRecord(latestRecord, {
        endedAt: latestRecord.endedAt ?? new Date().toISOString(),
      });
      return;
    }

    if (authLoopState.blockerReason) {
      await this.updateRecord(latestRecord, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        blockerReason: authLoopState.blockerReason,
      });
      return;
    }

    let agentResult: AgentResult | null = null;

    try {
      const parsed = await this.adapters.parseResult(record);
      agentResult = AgentResultSchema.parse(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendFile(record.artifacts.logPath, `\nFailed to parse agent result: ${message}\n`, 'utf8');
    }

    const changedFiles = await this.git.getChangedFiles(record.workspacePath);
    if (changedFiles.length > 0 && record.spec.commitOnStop) {
      await this.git.commitAll(record.workspacePath, `chore(agent-runner): snapshot ${record.id}`);
    }

    const headSha = await this.git.getHeadSha(record.workspacePath);
    record = await this.updateRecord(record, {
      headSha,
    });
    await this.writeArtifacts(record, changedFiles, agentResult, stagedSpec.sourcePath);

    if (dockerResult.exitCode !== 0 && !agentResult) {
      await this.updateRecord(record, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        blockerReason: `Worker exited with code ${dockerResult.exitCode}`,
      });
      return;
    }

    await this.updateRecord(record, {
      status: agentResult?.status ?? 'failed',
      blockerReason: agentResult?.blockerReason,
      endedAt: new Date().toISOString(),
    });
  }

  private async writeArtifacts(
    record: JobRecord,
    changedFiles: string[],
    agentResult: AgentResult | null,
    sourceSpecPath: string,
  ): Promise<void> {
    let diffContent = '';
    try {
      diffContent = (await runCommand('git', [ '-C', record.workspacePath, 'diff', 'HEAD~1..HEAD' ])).stdout;
    } catch {
      diffContent = '';
    }

    await writeFile(record.artifacts.gitDiffPath, diffContent, 'utf8');
    await writeJsonAtomic(record.artifacts.summaryPath, {
      id: record.id,
      status: agentResult?.status ?? record.status,
      blockerReason: agentResult?.blockerReason,
      branchName: record.branchName,
      changedFiles,
      headSha: record.headSha,
      finishedAt: new Date().toISOString(),
      debugCommand: record.debugCommand,
      workspacePath: record.workspacePath,
      specPath: record.spec.specPath,
      sourceSpecPath,
      resolvedSpec: record.resolvedSpec,
    });
  }

  private async resolveRuntimeAuth(
    runtime: JobSpec['agentRuntime'],
  ): Promise<{ ok: true; value: ResolvedRuntimeAuth } | { ok: false; message: string }> {
    const policy = this.adapters.runtimeAuthPolicy(runtime);
    const directValue = process.env[policy.envKey]?.trim();
    if (directValue) {
      return {
        ok: true,
        value: {
          env: { [policy.envKey]: directValue },
          source: 'env',
        },
      };
    }

    const helperCommand = process.env[policy.helperEnvVar]?.trim();
    if (helperCommand) {
      const helperResult = await runCommand('/bin/sh', [ '-lc', helperCommand ], {
        env: process.env,
      });
      const helperValue = helperResult.stdout.trim();
      if (helperResult.exitCode === 0 && helperValue) {
        return {
          ok: true,
          value: {
            env: { [ policy.envKey ]: helperValue },
            source: 'helper',
          },
        };
      }
    }

    if (policy.allowLocalStateFallback && await this.hasCodexLocalState()) {
      return {
        ok: true,
        value: {
          env: {},
          source: 'local-state',
        },
      };
    }

    return { ok: false, message: policy.missingAuthMessage };
  }

  private async hasCodexLocalState(): Promise<boolean> {
    if (!await pathExists(this.config.codexDir)) {
      return false;
    }

    try {
      const entries = await readdir(this.config.codexDir);
      return entries.length > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  private async observeRuntimeLog(record: JobRecord, chunk: string, state: AuthLoopState): Promise<void> {
    if (state.abortRequested || state.blockerReason) {
      return;
    }

    const policy = this.adapters.runtimeAuthPolicy(record.spec.agentRuntime);
    const lines = chunk.split(/\r?\n/);

    for (const line of lines) {
      if (policy.noisePatterns.some((pattern) => pattern.test(line))) {
        continue;
      }

      if (policy.authFailurePatterns.some((pattern) => pattern.test(line))) {
        state.authFailureCount += 1;
        continue;
      }

      state.meaningfulOutputSeen = true;
    }

    if (state.meaningfulOutputSeen || state.authFailureCount < 3) {
      return;
    }

    state.abortRequested = true;
    state.blockerReason = policy.authLoopMessage;
    await appendFile(record.artifacts.logPath, `${policy.authLoopMessage}\n`, 'utf8');

    if (record.containerId) {
      await this.docker.stopJob(record.containerId);
    }
  }

  private async acquireJobSlot(jobId: string): Promise<JobLockPayload | null> {
    for (;;) {
      const record = await this.requireJob(jobId);
      if (TERMINAL_STATUSES.has(record.status)) {
        return null;
      }

      try {
        const handle = await open(this.activeLockPath, 'wx');
        const payload: JobLockPayload = { jobId, pid: process.pid };
        await handle.writeFile(JSON.stringify(payload));
        await handle.close();
        return payload;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }

      if (await this.clearStaleLock()) {
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async cleanupActiveLockForJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = await this.readActiveLock();
      if (!payload || payload.jobId !== jobId) {
        return;
      }

      if (!payload.pid || !this.isProcessAlive(payload.pid)) {
        await safeRemove(this.activeLockPath);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async readActiveLock(): Promise<JobLockPayload | null> {
    try {
      const raw = await readFile(this.activeLockPath, 'utf8');
      return JSON.parse(raw) as JobLockPayload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async clearStaleLock(): Promise<boolean> {
    const payload = await this.readActiveLock();
    if (!payload) {
      return true;
    }

    if (!payload?.pid || this.isProcessAlive(payload.pid)) {
      return false;
    }

    await safeRemove(this.activeLockPath);
    return true;
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== 'ESRCH';
    }
  }

  private async releaseJobSlot(lock: JobLockPayload): Promise<void> {
    try {
      const raw = await readFile(this.activeLockPath, 'utf8');
      const current = JSON.parse(raw) as JobLockPayload;
      if (current.jobId !== lock.jobId || current.pid !== lock.pid) {
        return;
      }
      await unlink(this.activeLockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async requireJob(jobId: string): Promise<JobRecord> {
    const record = await this.store.get(jobId);
    if (!record) {
      throw new Error(`Job ${jobId} not found`);
    }
    return record;
  }

  private async updateRecord(record: JobRecord, patch: Partial<JobRecord>): Promise<JobRecord> {
    const next: JobRecord = {
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.store.save(next);
    this.events.emitRecord(next);
    return next;
  }
}
