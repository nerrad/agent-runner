import { randomUUID } from 'node:crypto';
import { appendFile, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentResult, JobRecord, JobSpec, JobStatus } from '../shared/types.js';
import { AgentResultSchema, JobSpecSchema } from '../shared/types.js';
import type { AgentStateAuditor } from './agent-state-audit.js';
import type { BrokerLeaseStore } from './broker-lease.js';
import type { RuntimeConfig } from './config.js';
import { buildHostGitEnv, createGitHostProfile } from './config.js';
import type { DockerBroker } from './docker-broker.js';
import type { DockerRunner } from './docker-runner.js';
import { ensureDir, safeRemove, writeJsonAtomic } from './fs-utils.js';
import type { McpBroker } from './mcp-broker.js';
import { rewriteMcpConfigs, type McpRewriteFileOverlay } from './mcp-rewriter.js';
import type { GitManager } from './git-manager.js';
import { JobEvents } from './job-events.js';
import { launchDetachedJobRunner } from './job-launcher.js';
import { buildJobPaths } from './paths.js';
import { AgentAdapters } from './agent-adapters.js';
import { runCommand } from './process-utils.js';
import { isValidBranchName } from './repo-broker.js';
import type { SecurityAuditLogger } from './security-audit-log.js';
import { stageSpecBundle } from './spec-resolver.js';
import { JobStore } from './job-store.js';

const TERMINAL_STATUSES = new Set<JobStatus>([ 'blocked', 'completed', 'failed', 'canceled' ]);
const RUNNER_LOG_PREFIX = '[agent-runner]';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface JobManagerOptions {
  runMode?: 'inline' | 'process';
  launchJobRunner?: (jobId: string) => Promise<void>;
  heartbeatIntervalMs?: number;
  debugPollIntervalMs?: number;
}

interface JobLockPayload {
  jobId: string;
  pid: number;
}

interface ResolvedRuntimeAuth {
  env: Record<string, string>;
  source: 'env';
}

interface AgentStateAuditResult {
  changed: boolean;
}

interface AuthLoopState {
  abortRequested: boolean;
  blockerReason?: string;
}

interface LogTarget {
  id: string;
  artifacts: JobRecord['artifacts'];
}

interface IdleHeartbeat {
  markAgentOutput(): void;
  stop(): void;
}

interface DebugLogFollower {
  stop(): Promise<void>;
}

interface ProgressFollowerState {
  warnedInvalidEvent: boolean;
  bufferedLine: string;
}

export type JobLogKind = 'run' | 'debug';

export class JobManager {
  private readonly activeLockPath: string;
  private readonly runMode: 'inline' | 'process';
  private readonly launchJobRunner: (jobId: string) => Promise<void>;
  private readonly heartbeatIntervalMs: number;
  private readonly debugPollIntervalMs: number;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly store: JobStore,
    private readonly events: JobEvents,
    private readonly git: GitManager,
    private readonly docker: DockerRunner,
    private readonly adapters: AgentAdapters,
    private readonly agentStateAuditor: AgentStateAuditor,
    private readonly brokerLeaseStore: BrokerLeaseStore,
    private readonly dockerBroker: DockerBroker,
    private readonly mcpBroker: McpBroker,
    private readonly securityAuditLogger: SecurityAuditLogger,
    options: JobManagerOptions = {},
  ) {
    this.activeLockPath = path.join(this.config.appDir, 'active-job.lock');
    this.runMode = options.runMode ?? 'process';
    this.launchJobRunner = options.launchJobRunner ?? ((jobId) => launchDetachedJobRunner(this.config, jobId));
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.debugPollIntervalMs = options.debugPollIntervalMs ?? 500;
  }

  async createJob(input: JobSpec): Promise<JobRecord> {
    const parsed = JobSpecSchema.parse(input);
    const spec = this.normalizeJobSpec(parsed);
    const id = randomUUID();
    const now = new Date().toISOString();
    const paths = buildJobPaths(this.config, id);
    const branchName = spec.branch ?? `agent-runner/${id}`;

    await ensureDir(paths.jobDir);
    await ensureDir(path.dirname(paths.workspacePath));
    await ensureDir(paths.artifactDir);
    await ensureDir(paths.artifacts.inputsDir);
    await ensureDir(paths.artifacts.outputsDir);

    this.validateAbsoluteSpecPath(spec.specPath);

    const record: JobRecord = {
      id,
      spec,
      status: 'queued',
      workspacePath: paths.workspacePath,
      branchName,
      defaultBranch: undefined,
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
      await this.appendRunnerLogLine(failedRecord, 'job failed');
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

    await this.cleanupBrokeredDockerResources(record);
    await this.cleanupMcpProcesses(record.id);
    await this.revokeBrokerLease(jobId);

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

  async readLog(jobId: string, kind: JobLogKind = 'run'): Promise<string> {
    const record = await this.getJob(jobId);
    if (!record) {
      throw new Error('Job not found');
    }

    try {
      return await readFile(kind === 'debug' ? record.artifacts.debugLogPath : record.artifacts.logPath, 'utf8');
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
        await this.cleanupBrokeredDockerResources(record);
        await this.cleanupMcpProcesses(jobId);
        await this.revokeBrokerLease(jobId);
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
        await this.revokeBrokerLease(jobId);
        await this.cleanupBrokeredDockerResources({
          ...record,
          status: 'failed',
        });
        await this.cleanupMcpProcesses(jobId);
      }
    } finally {
      await this.releaseJobSlot(lock);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    let record = await this.requireJob(jobId);
    const logTarget: LogTarget = {
      id: record.id,
      artifacts: record.artifacts,
    };
    const profile = createGitHostProfile(this.config, record.spec.githubHost);
    const runtimeAuth = await this.resolveRuntimeAuth(record.spec.agentRuntime);
    const runtimeEnv: Record<string, string> = runtimeAuth.ok ? { ...runtimeAuth.value.env } : {};
    let agentStateBefore = record.spec.agentStateMode === 'mounted'
      ? await this.agentStateAuditor.captureSnapshot()
      : null;
    let agentStateAudit: AgentStateAuditResult | null = null;

    if (profile.proxyUrl) {
      runtimeEnv.HTTPS_PROXY = profile.proxyUrl;
    }

    const hostProxyEnv = buildHostGitEnv(this.config, record.spec.githubHost);

    await writeFile(record.artifacts.logPath, '', 'utf8');
    await writeFile(record.artifacts.debugLogPath, '', 'utf8');
    await writeFile(record.artifacts.securityAuditPath, '', 'utf8');
    await writeFile(record.artifacts.progressEventsPath, '', 'utf8');
    await writeFile(record.artifacts.agentTranscriptPath, '', 'utf8');

    if (!runtimeAuth.ok) {
      await this.appendLogLine(logTarget, runtimeAuth.message);
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
    await this.appendRunnerLogLine(logTarget, 'cloning repository');

    await safeRemove(record.workspacePath);
    await ensureDir(path.dirname(record.workspacePath));
    await this.git.cloneRepository(record.spec.repoUrl, record.workspacePath, { ref: record.spec.ref, env: hostProxyEnv });
    const defaultBranch = await this.git.getDefaultBranch(record.workspacePath, { env: hostProxyEnv });
    await this.git.createBranch(record.workspacePath, record.branchName);
    record = await this.updateRecord(record, {
      defaultBranch,
      headSha: await this.git.getHeadSha(record.workspacePath),
    });

    record = await this.updateRecord(record, {
      status: 'bootstrapping',
    });
    await this.appendRunnerLogLine(logTarget, 'bootstrapping workspace and staging spec bundle');

    const stagedSpec = await stageSpecBundle(record.workspacePath, record.spec.specPath, record.artifacts.specBundlePath, this.config.specRoot);
    record = await this.updateRecord(record, {
      resolvedSpec: stagedSpec.resolvedSpec,
      specSourceType: stagedSpec.specSourceType,
    });

    const prepared = await this.adapters.prepare(record);
    const brokerLease = await this.maybeIssueBrokerLease(record);
    if (brokerLease) {
      const isBrokerProfile = record.spec.capabilityProfile === 'repo-broker' || record.spec.capabilityProfile === 'docker-broker';
      const containerToken = isBrokerProfile ? brokerLease.token : brokerLease.renameToken;
      runtimeEnv.AGENT_RUNNER_BROKER_TOKEN = containerToken;
      runtimeEnv.AGENT_RUNNER_BROKER_URL = this.config.brokerUrl;
      runtimeEnv.AGENT_RUNNER_JOB_ID = record.id;
      await writeJsonAtomic(record.artifacts.brokerEnvPath ?? path.join(record.artifacts.inputsDir, 'broker-env.json'), {
        AGENT_RUNNER_BROKER_TOKEN: containerToken,
        AGENT_RUNNER_BROKER_URL: this.config.brokerUrl,
        AGENT_RUNNER_JOB_ID: record.id,
      });
    }
    let mcpOverlays: McpRewriteFileOverlay[] | undefined;
    if (record.spec.agentStateMode === 'mounted' && brokerLease) {
      const isBrokerProfile = record.spec.capabilityProfile === 'repo-broker' || record.spec.capabilityProfile === 'docker-broker';
      const containerToken = isBrokerProfile ? brokerLease.token : brokerLease.renameToken;
      const mcpStagingDir = path.join(path.dirname(record.artifacts.outputsDir), 'mcp-staging');
      try {
        const rewriteResult = await rewriteMcpConfigs(
          this.config, mcpStagingDir, record.id, this.config.brokerUrl, containerToken,
        );
        if (rewriteResult.manifest.length > 0) {
          mcpOverlays = rewriteResult.overlays;
          // Fallback path handles records created before mcpManifestPath was added to ArtifactBundle
          await writeJsonAtomic(record.artifacts.mcpManifestPath ?? path.join(path.dirname(record.artifacts.logPath), 'mcp-manifest.json'), rewriteResult.manifest);
          await this.appendRunnerLogLine(logTarget,
            `MCP proxy: ${rewriteResult.manifest.length} server(s) rewritten [${rewriteResult.manifest.map((s) => s.name).join(', ')}]`);
        }
        if (rewriteResult.skipped.length > 0) {
          await this.appendRunnerLogLine(logTarget,
            `MCP proxy: ${rewriteResult.skipped.length} URL-based server(s) unchanged [${rewriteResult.skipped.join(', ')}]`);
        }
      } catch (error) {
        await this.appendRunnerLogLine(logTarget, `MCP proxy rewrite failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.appendRunnerLogLine(logTarget, 'building worker image and launching agent');
    await this.docker.ensureImageBuilt();

    record = await this.updateRecord(record, {
      status: 'running',
    });
    const heartbeat = this.startIdleHeartbeat(logTarget);

    const authLoopState: AuthLoopState = {
      abortRequested: false,
    };
    const debugLogFollower = this.startDebugLogFollower(record, authLoopState);
    const progressFollower = this.startProgressEventFollower(record, heartbeat);

    let dockerResult: { containerId: string; exitCode: number };
    try {
      dockerResult = await this.docker.runJob({
        job: record,
        command: prepared.command,
        env: runtimeEnv,
        mcpOverlays,
        onStart: async (containerId) => {
          record = await this.updateRecord(record, {
            containerId,
            debugCommand: this.docker.createDebugCommand({ ...record, containerId }),
          });
          await this.appendRunnerLogLine(logTarget, `container started: ${containerId}`);
        },
        onLog: async (chunk) => {
          heartbeat.markAgentOutput();
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
    } finally {
      heartbeat.stop();
      await debugLogFollower.stop();
      await progressFollower.stop();
      if (agentStateBefore) {
        const agentStateAfter = await this.agentStateAuditor.captureSnapshot();
        const summary = await this.agentStateAuditor.writeAudit(record.artifacts, agentStateBefore, agentStateAfter);
        agentStateAudit = { changed: summary.changed };
        record = await this.updateRecord(record, {
          agentStateModified: summary.changed,
        });
        agentStateBefore = null;
      }
    }

    const latestRecord = await this.requireJob(record.id);
    if (latestRecord.status === 'canceled') {
      await this.cleanupBrokeredDockerResources(latestRecord);
      await this.cleanupMcpProcesses(latestRecord.id);
      await this.revokeBrokerLease(latestRecord.id);
      await this.updateRecord(latestRecord, {
        endedAt: latestRecord.endedAt ?? new Date().toISOString(),
      });
      return;
    }

    if (authLoopState.blockerReason) {
      await this.cleanupBrokeredDockerResources(latestRecord);
      await this.cleanupMcpProcesses(latestRecord.id);
      await this.revokeBrokerLease(latestRecord.id);
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
      await this.appendLogLine(logTarget, `Failed to parse agent result: ${message}`);
    }

    const changedFiles = await this.git.getChangedFiles(record.workspacePath);
    let committed = false;
    if (changedFiles.length > 0 && record.spec.commitOnStop) {
      committed = await this.git.commitAll(record.workspacePath, `chore(agent-runner): snapshot ${record.id}`);
    }

    const actualBranch = await this.git.getCurrentBranch(record.workspacePath);
    if (actualBranch !== record.branchName && isValidBranchName(actualBranch)) {
      record = await this.updateRecord(record, { branchName: actualBranch });
    }

    const headSha = await this.git.getHeadSha(record.workspacePath);
    record = await this.updateRecord(record, {
      headSha,
    });
    await this.writeArtifacts(record, changedFiles, agentResult, stagedSpec.sourcePath, stagedSpec.specSourceType, committed, agentStateAudit);

    if (dockerResult.exitCode !== 0 && !agentResult) {
      await this.cleanupBrokeredDockerResources(record);
      await this.cleanupMcpProcesses(record.id);
      await this.revokeBrokerLease(record.id);
      await this.updateRecord(record, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        blockerReason: `Worker exited with code ${dockerResult.exitCode}`,
      });
      return;
    }

    const completedRecord = await this.updateRecord(record, {
      status: agentResult?.status ?? 'failed',
      blockerReason: agentResult?.blockerReason,
      endedAt: new Date().toISOString(),
    });
    await this.cleanupBrokeredDockerResources(completedRecord);
    await this.cleanupMcpProcesses(completedRecord.id);
    await this.revokeBrokerLease(completedRecord.id);
  }

  private async writeArtifacts(
    record: JobRecord,
    changedFiles: string[],
    agentResult: AgentResult | null,
    sourceSpecPath: string,
    specSourceType: 'repo-relative' | 'external-spec-root',
    committed: boolean,
    agentStateAudit: AgentStateAuditResult | null,
  ): Promise<void> {
    let finalResponseContent = '';
    try {
      finalResponseContent = await readFile(record.artifacts.finalResponsePath, 'utf8');
    } catch {
      finalResponseContent = '';
    }

    let diffContent = '';
    try {
      diffContent = committed
        ? (await runCommand('git', [ '-C', record.workspacePath, 'diff', 'HEAD~1..HEAD' ])).stdout
        : (await runCommand('git', [ '-C', record.workspacePath, 'diff' ])).stdout;
    } catch {
      diffContent = '';
    }

    await writeFile(record.artifacts.gitDiffPath, diffContent, 'utf8');
    if (finalResponseContent.trim().length > 0) {
      await appendFile(
        record.artifacts.agentTranscriptPath,
        `\n[agent-runner] final structured response\n${finalResponseContent}\n`,
        'utf8',
      );
    }
    const branchSource = record.spec.branch ? 'explicit'
      : (record.branchName !== `agent-runner/${record.id}` ? 'convention' : 'auto');
    await writeJsonAtomic(record.artifacts.summaryPath, {
      id: record.id,
      status: agentResult?.status ?? record.status,
      summary: agentResult?.summary,
      blockerReason: agentResult?.blockerReason,
      branchName: record.branchName,
      branchSource,
      changedFiles,
      headSha: record.headSha,
      finishedAt: new Date().toISOString(),
      debugCommand: record.debugCommand,
      workspacePath: record.workspacePath,
      specPath: record.spec.specPath,
      sourceSpecPath,
      specSourceType,
      resolvedSpec: record.resolvedSpec,
      agentStateModified: agentStateAudit?.changed ?? false,
      ...await this.readMcpSummary(record),
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

    return { ok: false, message: policy.missingAuthMessage };
  }

  private async observeRuntimeLog(record: JobRecord, chunk: string, state: AuthLoopState): Promise<void> {
    await this.observeAuthSignals(record, chunk, state, 'run log');
  }

  private async observeDebugLog(record: JobRecord, chunk: string, state: AuthLoopState): Promise<void> {
    await this.observeAuthSignals(record, chunk, state, 'debug log');
  }

  private async observeProgressEvents(
    record: JobRecord,
    chunk: string,
    state: ProgressFollowerState,
    heartbeat: IdleHeartbeat,
  ): Promise<void> {
    const combined = `${state.bufferedLine}${chunk}`;
    const trailingLineIsPartial = !combined.endsWith('\n') && !combined.endsWith('\r');
    const lines = combined.split(/\r?\n/);
    state.bufferedLine = trailingLineIsPartial ? (lines.pop() ?? '') : '';

    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (parsed.kind !== 'progress' || message.length === 0) {
          throw new Error('Invalid progress event');
        }

        heartbeat.markAgentOutput();
        const canonicalLine = `[progress] ${message.replace(/\r?\n/g, ' ')}`;
        await this.appendLogLine(record, canonicalLine);
        await appendFile(record.artifacts.agentTranscriptPath, `${canonicalLine}\n`, 'utf8');
      } catch {
        if (!state.warnedInvalidEvent) {
          state.warnedInvalidEvent = true;
          await this.appendRunnerLogLine(record, 'ignoring invalid progress sidecar event');
        }
      }
    }
  }

  private async observeAuthSignals(
    record: JobRecord,
    chunk: string,
    state: AuthLoopState,
    source: 'run log' | 'debug log',
  ): Promise<void> {
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
        state.abortRequested = true;
        state.blockerReason = policy.authFailureMessage;
        await this.appendRunnerLogLine(record, `${policy.authFailureMessage} Detected in ${source}.`);
        if (record.containerId) {
          await this.docker.stopJob(record.containerId);
        }
        return;
      }
    }
  }

  private startDebugLogFollower(record: JobRecord, state: AuthLoopState): DebugLogFollower {
    let stopped = false;
    let running = false;
    let sentLength = 0;
    let stopResolver: (() => void) | null = null;
    const stoppedPromise = new Promise<void>((resolve) => {
      stopResolver = resolve;
    });

    const timer = setInterval(() => {
      if (stopped || running) {
        return;
      }

      running = true;
      void (async () => {
        try {
          const latestRecord = await this.store.get(record.id);
          if (!latestRecord) {
            stopped = true;
            return;
          }

          const content = await this.readLog(record.id, 'debug');
          if (content.length > sentLength) {
            const chunk = content.slice(sentLength);
            sentLength = content.length;
            await this.observeDebugLog(latestRecord, chunk, state);
          }

          if (TERMINAL_STATUSES.has(latestRecord.status)) {
            stopped = true;
          }
        } finally {
          running = false;
          if (stopped) {
            clearInterval(timer);
            stopResolver?.();
          }
        }
      })().catch(() => {
        stopped = true;
      });
    }, this.debugPollIntervalMs);

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        if (!running) {
          stopResolver?.();
        }
        await stoppedPromise;
      },
    };
  }

  private startProgressEventFollower(record: JobRecord, heartbeat: IdleHeartbeat): DebugLogFollower {
    let stopped = false;
    let running = false;
    let sentLength = 0;
    let stopResolver: (() => void) | null = null;
    const state: ProgressFollowerState = {
      warnedInvalidEvent: false,
      bufferedLine: '',
    };
    const stoppedPromise = new Promise<void>((resolve) => {
      stopResolver = resolve;
    });

    const pollOnce = async (): Promise<void> => {
      const latestRecord = await this.store.get(record.id);
      if (!latestRecord) {
        stopped = true;
        return;
      }

      let content = '';
      try {
        content = await readFile(latestRecord.artifacts.progressEventsPath, 'utf8');
      } catch {
        content = '';
      }

      if (content.length > sentLength) {
        const chunk = content.slice(sentLength);
        sentLength = content.length;
        await this.observeProgressEvents(latestRecord, chunk, state, heartbeat);
      }

      if (TERMINAL_STATUSES.has(latestRecord.status)) {
        stopped = true;
      }
    };

    const timer = setInterval(() => {
      if (stopped || running) {
        return;
      }

      running = true;
      void pollOnce()
        .catch(() => {
          stopped = true;
        })
        .finally(() => {
          running = false;
          if (stopped) {
            clearInterval(timer);
            stopResolver?.();
          }
        });
    }, this.debugPollIntervalMs);

    return {
      stop: async () => {
        clearInterval(timer);
        if (running) {
          stopped = true;
          await stoppedPromise;
          await pollOnce().catch(() => undefined);
          return;
        }

        await pollOnce().catch(() => undefined);
        stopped = true;
        stopResolver?.();
        await stoppedPromise;
      },
    };
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

    const stalePath = `${this.activeLockPath}.stale-${process.pid}-${Date.now()}`;
    try {
      await rename(this.activeLockPath, stalePath);
      await safeRemove(stalePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return true;
      }
      return false;
    }
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
    if (!TERMINAL_STATUSES.has(record.status) && TERMINAL_STATUSES.has(next.status)) {
      await this.appendRunnerLogLine(next, `job ${next.status}`);
    }
    return next;
  }

  private async appendLogLine(target: LogTarget, line: string): Promise<void> {
    const chunk = `${line}\n`;
    await appendFile(target.artifacts.logPath, chunk, 'utf8');
    this.events.emitLog({
      jobId: target.id,
      chunk,
      at: new Date().toISOString(),
    });
  }

  private async appendRunnerLogLine(target: LogTarget, message: string): Promise<void> {
    await this.appendLogLine(target, `${RUNNER_LOG_PREFIX} ${message}`);
  }

  private normalizeJobSpec(spec: JobSpec): JobSpec {
    const capabilityProfile = spec.capabilityProfile ?? 'safe';
    const agentStateMode = spec.agentStateMode ?? 'mounted';

    // Auto-derive repoAccessMode from profile when the caller left it at the
    // Zod default ('none') and the profile implies a different value.
    let repoAccessMode = spec.repoAccessMode ?? 'none';
    const callerLeftDefault = repoAccessMode === 'none';

    if (callerLeftDefault) {
      switch (capabilityProfile) {
        case 'safe':
          repoAccessMode = 'none';
          break;
        case 'repo-broker':
        case 'docker-broker':
          repoAccessMode = 'broker';
          break;
        case 'dangerous':
          throw new Error('dangerous jobs require an explicit repoAccessMode (broker or ambient)');
      }
    } else {
      // Explicit value provided — validate the pairing
      if (capabilityProfile === 'dangerous' && repoAccessMode === 'none') {
        throw new Error('dangerous jobs cannot use repoAccessMode=none; choose ambient or a safer profile');
      }
      if (capabilityProfile === 'safe' && repoAccessMode !== 'none') {
        throw new Error('safe jobs must use repoAccessMode=none');
      }
      if ((capabilityProfile === 'repo-broker' || capabilityProfile === 'docker-broker') && repoAccessMode !== 'broker') {
        throw new Error(`${capabilityProfile} jobs must use repoAccessMode=broker`);
      }
    }

    return {
      ...spec,
      capabilityProfile,
      repoAccessMode,
      agentStateMode,
    };
  }

  private validateAbsoluteSpecPath(specPath: string): void {
    if (!path.isAbsolute(specPath)) {
      return;
    }

    const relative = path.relative(this.config.specRoot, specPath);
    if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
      throw new Error(`Absolute spec paths must stay inside ${this.config.specRoot}`);
    }
  }

  private async maybeIssueBrokerLease(record: JobRecord) {
    return await this.brokerLeaseStore.issue(record);
  }

  private async revokeBrokerLease(jobId: string): Promise<void> {
    await this.brokerLeaseStore.revoke(jobId);
  }

  private async readMcpSummary(record: JobRecord): Promise<{ mcpProxiedServers?: string[]; mcpUrlServers?: string[] }> {
    const manifestPath = record.artifacts.mcpManifestPath;
    if (!manifestPath) {
      return {};
    }
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as Array<{ name: string }>;
      return { mcpProxiedServers: manifest.map((e) => e.name) };
    } catch {
      return {};
    }
  }

  private async cleanupMcpProcesses(jobId: string): Promise<void> {
    try {
      await this.mcpBroker.cleanupJob(jobId);
    } catch (error) {
      // Non-fatal: MCP process cleanup failure shouldn't block job completion
    }
  }

  private async cleanupBrokeredDockerResources(record: JobRecord): Promise<void> {
    if (record.spec.capabilityProfile !== 'docker-broker') {
      return;
    }

    try {
      await this.dockerBroker.cleanupJob(record);
    } catch (error) {
      await this.appendRunnerLogLine(record, `docker cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startIdleHeartbeat(target: LogTarget): IdleHeartbeat {
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    let generation = 0;

    const schedule = (): void => {
      generation += 1;
      const expectedGeneration = generation;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void (async () => {
          if (stopped || generation !== expectedGeneration) {
            return;
          }

          const latest = await this.store.get(target.id);
          if (!latest || latest.status !== 'running') {
            stopped = true;
            return;
          }

          await this.appendRunnerLogLine(target, 'still running; waiting for agent output');

          if (!stopped && generation === expectedGeneration) {
            schedule();
          }
        })().catch(() => {
          stopped = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        });
      }, this.heartbeatIntervalMs);
    };

    schedule();

    return {
      markAgentOutput: () => {
        schedule();
      },
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }
}
