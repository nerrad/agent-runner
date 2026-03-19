import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AgentResult, JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import type { DockerRunRequest } from '../server/docker-runner.js';
import { pathExists } from '../server/fs-utils.js';
import { AgentStateAuditor } from '../server/agent-state-audit.js';
import { BrokerLeaseStore } from '../server/broker-lease.js';
import { DockerBroker } from '../server/docker-broker.js';
import { McpBroker } from '../server/mcp-broker.js';
import { JobStore } from '../server/job-store.js';
import { JobEvents } from '../server/job-events.js';
import type { BrokerHandle, JobManagerOptions } from '../server/job-manager.js';
import { JobManager } from '../server/job-manager.js';
import { SecurityAuditLogger } from '../server/security-audit-log.js';
import { AgentAdapters } from '../server/agent-adapters.js';

const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

class MockGitManager {
  public changedFiles = [ ' M src/index.ts' ];
  public headSha = 'abc123';
  public defaultBranch = 'main';
  public currentBranch = '';

  public lastCloneEnv: NodeJS.ProcessEnv | undefined = undefined;
  public lastDefaultBranchEnv: NodeJS.ProcessEnv | undefined = undefined;

  async cloneRepository(_repoUrl: string, workspacePath: string, options?: { ref?: string; env?: NodeJS.ProcessEnv }): Promise<void> {
    this.lastCloneEnv = options?.env;
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, '.gitkeep'), '', 'utf8');
    await mkdir(path.join(workspacePath, 'agent-os', 'specs', 'example'), { recursive: true });
    await writeFile(path.join(workspacePath, 'agent-os', 'specs', 'example', 'plan.md'), '# Plan\n', 'utf8');
    await writeFile(path.join(workspacePath, 'agent-os', 'specs', 'example', 'shape.md'), '# Shape\n', 'utf8');
  }

  async createBranch(_workspacePath: string, branchName: string): Promise<void> {
    this.currentBranch = branchName;
  }
  async getDefaultBranch(_targetPath?: string, options?: { env?: NodeJS.ProcessEnv }): Promise<string> {
    this.lastDefaultBranchEnv = options?.env;
    return this.defaultBranch;
  }
  async getHeadSha(): Promise<string> { return this.headSha; }
  async getChangedFiles(): Promise<string[]> { return this.changedFiles; }
  async ensureExcludePatterns(): Promise<void> {}
  async commitAll(): Promise<boolean> { return true; }
  async getCurrentBranch(): Promise<string> { return this.currentBranch; }
}

class MockDockerRunner {
  public stoppedContainerId: string | null = null;
  public lastEnv: Record<string, string> | null = null;
  public runCount = 0;
  public ensureImageBuiltCount = 0;

  async ensureImageBuilt(): Promise<void> {
    this.ensureImageBuiltCount += 1;
  }

  async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-123');
    await request.onLog('starting\n');
    await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify({
      status: 'completed',
      summary: 'done',
      blockerReason: null,
    }), 'utf8');
    return {
      containerId: 'container-123',
      exitCode: 0,
    };
  }

  async stopJob(containerId: string): Promise<void> {
    this.stoppedContainerId = containerId;
  }

  createDebugCommand(record: JobRecord): string {
    return `docker exec -it ${record.containerId} bash`;
  }

  async appendTranscript(): Promise<void> {}
}

class BlockingDockerRunner extends MockDockerRunner {
  private pendingResolve: (() => void) | null = null;

  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-blocking');
    await request.onLog('running\n');
    await new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
    });
    return {
      containerId: 'container-blocking',
      exitCode: 137,
    };
  }

  override async stopJob(containerId: string): Promise<void> {
    await super.stopJob(containerId);
    this.pendingResolve?.();
  }
}

class DebugAuthDockerRunner extends MockDockerRunner {
  private pendingResolve: (() => void) | null = null;

  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-debug-auth');
    setTimeout(() => {
      void writeFile(request.job.artifacts.debugLogPath, '401 authentication_error invalid x-api-key\n', 'utf8');
    }, 10);
    await new Promise<void>((resolve) => {
      this.pendingResolve = resolve;
    });
    return {
      containerId: 'container-debug-auth',
      exitCode: 137,
    };
  }

  override async stopJob(containerId: string): Promise<void> {
    await super.stopJob(containerId);
    this.pendingResolve?.();
  }
}

class ScriptedDockerRunner extends MockDockerRunner {
  constructor(
    private readonly chunks: string[],
    private readonly result: AgentResult | null,
    private readonly exitCode = 0,
  ) {
    super();
  }

  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-scripted');

    for (const chunk of this.chunks) {
      await request.onLog(chunk);
      if (this.stoppedContainerId) {
        return {
          containerId: 'container-scripted',
          exitCode: 137,
        };
      }
    }

    if (this.result) {
      await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify(this.result), 'utf8');
    }

    return {
      containerId: 'container-scripted',
      exitCode: this.exitCode,
    };
  }
}

class SilentDockerRunner extends MockDockerRunner {
  constructor(private readonly delayMs: number) {
    super();
  }

  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-silent');
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify({
      status: 'completed',
      summary: 'done',
      blockerReason: null,
    }), 'utf8');
    return {
      containerId: 'container-silent',
      exitCode: 0,
    };
  }
}

class SingleOutputThenSilentDockerRunner extends MockDockerRunner {
  constructor(private readonly delayMs: number) {
    super();
  }

  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-one-output');
    await request.onLog('initial output\n');
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify({
      status: 'completed',
      summary: 'done',
      blockerReason: null,
    }), 'utf8');
    return {
      containerId: 'container-one-output',
      exitCode: 0,
    };
  }
}

function createRuntimeConfig(root: string): RuntimeConfig {
  return {
    appDir: root,
    jobsDir: path.join(root, 'jobs'),
    workspacesDir: path.join(root, 'workspaces'),
    artifactsDir: path.join(root, 'artifacts'),
    specRoot: path.join(root, 'specs'),
    ghConfigDir: path.join(root, 'gh'),
    claudeDir: path.join(root, 'claude'),
    claudeSettingsPath: path.join(root, '.claude.json'),
    codexDir: path.join(root, 'codex'),
    dockerSocketPath: '/tmp/docker.sock',
    hostUid: 501,
    hostGid: 20,
    sshAuthSock: '/tmp/ssh.sock',
    githubProxyUrl: 'socks5://host.docker.internal:8080',
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: path.resolve(new URL('../..', import.meta.url).pathname),
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
  };
}

function clearAuthEnv(): void {
  for (const key of AUTH_ENV_KEYS) {
    delete process.env[key];
  }
}

function createManager(
  config: RuntimeConfig,
  docker: MockDockerRunner,
  options: JobManagerOptions = {},
): { manager: JobManager; store: JobStore; events: JobEvents } {
  const store = new JobStore(config);
  const events = new JobEvents();
  const manager = new JobManager(
    config,
    store,
    events,
    new MockGitManager() as never,
    docker as never,
    new AgentAdapters(),
    new AgentStateAuditor(config),
    new BrokerLeaseStore(config),
    new DockerBroker(config),
    new McpBroker(config),
    new SecurityAuditLogger(),
    {
      runMode: 'inline',
      ...options,
    },
  );

  return { manager, store, events };
}

async function waitForJob(
  store: JobStore,
  jobId: string,
  statuses: Array<JobRecord['status']>,
): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await store.get(jobId);
    if (record && statuses.includes(record.status)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${statuses.join(', ')}`);
}

async function waitForJobWithContainer(store: JobStore, jobId: string): Promise<JobRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await store.get(jobId);
    if (record?.containerId) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for container assignment');
}

async function createJob(manager: JobManager, agentRuntime: 'claude' | 'codex'): Promise<JobRecord> {
  return await manager.createJob({
    repoUrl: 'git@github.com:owner/repo.git',
    specPath: 'agent-os/specs/example',
    agentRuntime,
    effort: 'auto',
    githubHost: 'github.com',
    commitOnStop: true,
    wpEnvEnabled: true,
    capabilityProfile: 'dangerous',
    repoAccessMode: 'ambient',
    agentStateMode: 'mounted',
  });
}

test('job manager processes a claude job through completion with direct env auth', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-jobs-'));
  const docker = new MockDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  const log = await readFile(finished.artifacts.logPath, 'utf8');
  const summary = JSON.parse(await readFile(finished.artifacts.summaryPath, 'utf8')) as { summary?: string };
  const transcript = await readFile(finished.artifacts.agentTranscriptPath, 'utf8');

  assert.equal(finished.status, 'completed');
  assert.equal(finished.containerId, 'container-123');
  assert.equal(docker.lastEnv?.ANTHROPIC_API_KEY, 'test-anthropic-key');
  assert.match(finished.debugCommand ?? '', /docker exec -it container-123 bash/);
  assert.equal(finished.headSha, 'abc123');
  assert.equal(finished.agentStateModified, false);
  assert.equal(finished.resolvedSpec?.specMode, 'bundle');
  assert.deepEqual(finished.resolvedSpec?.specFiles, [ '/spec/plan.md', '/spec/shape.md' ]);
  assert.match(log, /\[agent-runner\] cloning repository/);
  assert.match(log, /\[agent-runner\] bootstrapping workspace and staging spec bundle/);
  assert.match(log, /\[agent-runner\] building worker image and launching agent/);
  assert.match(log, /\[agent-runner\] container started: container-123/);
  assert.match(log, /\[agent-runner\] job completed/);
  assert.equal(summary.summary, 'done');
  assert.match(transcript, /\[agent-runner\] final structured response/);
  assert.match(transcript, /"summary":"done"/);

  clearAuthEnv();
});

test('job manager uses explicit branch name from spec when provided', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-explicit-branch-'));
  const docker = new MockDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await manager.createJob({
    repoUrl: 'git@github.com:owner/repo.git',
    specPath: 'agent-os/specs/example',
    agentRuntime: 'claude',
    effort: 'auto',
    githubHost: 'github.com',
    commitOnStop: true,
    wpEnvEnabled: true,
    capabilityProfile: 'dangerous',
    repoAccessMode: 'ambient',
    agentStateMode: 'mounted',
    branch: 'feature/my-branch',
  });

  assert.equal(job.branchName, 'feature/my-branch');

  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  assert.equal(finished.branchName, 'feature/my-branch');

  const summary = JSON.parse(await readFile(finished.artifacts.summaryPath, 'utf8')) as { branchSource?: string; branchName?: string };
  assert.equal(summary.branchSource, 'explicit');
  assert.equal(summary.branchName, 'feature/my-branch');

  clearAuthEnv();
});

test('job manager writes branchSource auto when branch matches UUID default', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-branch-auto-'));
  const docker = new MockDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);

  const summary = JSON.parse(await readFile(finished.artifacts.summaryPath, 'utf8')) as { branchSource?: string };
  assert.equal(summary.branchSource, 'auto');

  clearAuthEnv();
});

test('job manager writes branchSource convention when agent renames branch during execution', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-branch-convention-'));
  const docker = new MockDockerRunner();
  const git = new MockGitManager();
  const config = createRuntimeConfig(root);
  const store = new JobStore(config);
  const events = new JobEvents();
  const manager = new JobManager(
    config,
    store,
    events,
    git as never,
    docker as never,
    new AgentAdapters(),
    new AgentStateAuditor(config),
    new BrokerLeaseStore(config),
    new DockerBroker(config),
    new McpBroker(config),
    new SecurityAuditLogger(),
    { runMode: 'inline' },
  );

  // Simulate the agent renaming the branch during execution
  const originalRunJob = docker.runJob.bind(docker);
  docker.runJob = async (request: DockerRunRequest) => {
    git.currentBranch = 'feature/agent-chosen-name';
    return originalRunJob(request);
  };

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);

  assert.equal(finished.branchName, 'feature/agent-chosen-name');
  const summary = JSON.parse(await readFile(finished.artifacts.summaryPath, 'utf8')) as { branchSource?: string };
  assert.equal(summary.branchSource, 'convention');

  clearAuthEnv();
});

class ProgressDockerRunner extends MockDockerRunner {
  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-progress');
    await request.onLog('starting\n');
    await writeFile(
      request.job.artifacts.progressEventsPath,
      `${JSON.stringify({ kind: 'progress', message: 'syncing files', at: '2026-03-09T12:00:00Z' })}\n`,
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify({
      status: 'completed',
      summary: 'done',
      blockerReason: null,
    }), 'utf8');
    return {
      containerId: 'container-progress',
      exitCode: 0,
    };
  }
}

class InvalidProgressDockerRunner extends MockDockerRunner {
  override async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    this.runCount += 1;
    this.lastEnv = { ...request.env };
    await request.onStart?.('container-invalid-progress');
    await writeFile(request.job.artifacts.progressEventsPath, '{\"kind\":\"progress\"', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      request.job.artifacts.progressEventsPath,
      `${'{\"kind\":\"progress\"'}\n${JSON.stringify({ kind: 'progress', message: 'finishing', at: '2026-03-09T12:01:00Z' })}\n`,
      'utf8',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify({
      status: 'completed',
      summary: 'done',
      blockerReason: null,
    }), 'utf8');
    return {
      containerId: 'container-invalid-progress',
      exitCode: 0,
    };
  }
}

test('claude jobs fail before docker launch when no auth is available', async () => {
  clearAuthEnv();

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-no-claude-auth-'));
  const docker = new MockDockerRunner();
  const { manager } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const log = await readFile(job.artifacts.logPath, 'utf8');

  assert.equal(job.status, 'failed');
  assert.match(job.blockerReason ?? '', /ANTHROPIC_API_KEY/);
  assert.equal(docker.ensureImageBuiltCount, 0);
  assert.equal(docker.runCount, 0);
  assert.match(log, /ANTHROPIC_API_KEY/);
});

test('job manager ingests progress sidecar events into the log, transcript, and live event stream', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-progress-'));
  const docker = new ProgressDockerRunner();
  const { manager, store, events } = createManager(createRuntimeConfig(root), docker, {
    debugPollIntervalMs: 10,
    heartbeatIntervalMs: 100,
  });

  const job = await createJob(manager, 'codex');
  const liveChunks: string[] = [];
  const unsubscribe = events.subscribe(job.id, (event) => {
    if (event.type === 'log' && event.log) {
      liveChunks.push(event.log.chunk);
    }
  });

  try {
    const finished = await waitForJob(store, job.id, [ 'completed' ]);
    const log = await readFile(finished.artifacts.logPath, 'utf8');
    const transcript = await readFile(finished.artifacts.agentTranscriptPath, 'utf8');

    assert.match(log, /\[progress\] syncing files/);
    assert.match(transcript, /\[progress\] syncing files/);
    assert.ok(liveChunks.some((chunk) => chunk.includes('[progress] syncing files')));
  } finally {
    unsubscribe();
    clearAuthEnv();
  }
});

test('job manager ignores malformed progress events with one warning and continues the job', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-invalid-progress-'));
  const docker = new InvalidProgressDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker, {
    debugPollIntervalMs: 10,
  });

  const job = await createJob(manager, 'codex');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  const log = await readFile(finished.artifacts.logPath, 'utf8');
  const transcript = await readFile(finished.artifacts.agentTranscriptPath, 'utf8');
  const warningMatches = log.match(/\[agent-runner\] ignoring invalid progress sidecar event/g) ?? [];

  assert.equal(finished.status, 'completed');
  assert.equal(warningMatches.length, 1);
  assert.match(log, /\[progress\] finishing/);
  assert.match(transcript, /\[progress\] finishing/);

  clearAuthEnv();
});

test('codex jobs fail before docker launch when no key can be automatically resolved', async () => {
  clearAuthEnv();

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-no-codex-auth-'));
  const docker = new MockDockerRunner();
  const { manager } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'codex');

  assert.equal(job.status, 'failed');
  assert.match(job.blockerReason ?? '', /OPENAI_API_KEY/);
  assert.equal(docker.runCount, 0);
});

test('claude auth failures in the debug log stop the container and fail the job immediately', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-debug-auth-'));
  const docker = new DebugAuthDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker, {
    debugPollIntervalMs: 10,
  });

  const job = await createJob(manager, 'claude');
  const failed = await waitForJob(store, job.id, [ 'failed' ]);
  const log = await readFile(failed.artifacts.logPath, 'utf8');
  const debugLog = await readFile(failed.artifacts.debugLogPath, 'utf8');

  assert.equal(docker.stoppedContainerId, 'container-debug-auth');
  assert.match(failed.blockerReason ?? '', /authentication failed/i);
  assert.match(log, /Detected in debug log/i);
  assert.match(debugLog, /invalid x-api-key/i);

  clearAuthEnv();
});

test('codex auth errors in the runtime log stop the container immediately', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-auth-stop-'));
  const docker = new ScriptedDockerRunner([
    '401 Unauthorized\n',
    'Please run codex --login\n',
  ], null, 137);
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'codex');
  const failed = await waitForJob(store, job.id, [ 'failed' ]);
  const log = await readFile(failed.artifacts.logPath, 'utf8');

  assert.equal(docker.stoppedContainerId, 'container-scripted');
  assert.match(failed.blockerReason ?? '', /authentication failed/i);
  assert.match(log, /Detected in run log/i);

  clearAuthEnv();
});

test('cancelJob stops the active container, keeps canceled state, and removes the active lock', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cancel-'));
  const config = createRuntimeConfig(root);
  const docker = new BlockingDockerRunner();
  const { manager, store } = createManager(config, docker);

  const job = await createJob(manager, 'codex');
  const running = await waitForJobWithContainer(store, job.id);
  assert.equal(running.containerId, 'container-blocking');
  assert.equal(await pathExists(path.join(config.appDir, 'active-job.lock')), true);

  const canceled = await manager.cancelJob(job.id);
  const log = await readFile(job.artifacts.logPath, 'utf8');

  assert.ok(canceled);
  assert.equal(canceled.status, 'canceled');
  assert.equal(docker.stoppedContainerId, 'container-blocking');
  assert.equal(await pathExists(path.join(config.appDir, 'active-job.lock')), false);
  assert.match(log, /\[agent-runner\] job canceled/);

  clearAuthEnv();
});

test('silent runs emit idle heartbeats and stop after the final runner annotation', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-heartbeat-'));
  const docker = new SilentDockerRunner(80);
  const { manager, store } = createManager(createRuntimeConfig(root), docker, {
    heartbeatIntervalMs: 20,
  });

  const job = await createJob(manager, 'codex');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  const log = await readFile(finished.artifacts.logPath, 'utf8');
  const heartbeatMatches = log.match(/\[agent-runner\] still running; waiting for agent output/g) ?? [];
  const finalMatches = log.match(/\[agent-runner\] job completed/g) ?? [];
  const finalIndex = log.lastIndexOf('[agent-runner] job completed');
  const trailingLog = log.slice(finalIndex);

  assert.equal(finished.status, 'completed');
  assert.ok(heartbeatMatches.length >= 1);
  assert.equal(finalMatches.length, 1);
  assert.doesNotMatch(trailingLog, /still running; waiting for agent output/);

  clearAuthEnv();
});

test('idle heartbeat is scheduled from the last agent output, not the start of the run', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-heartbeat-after-output-'));
  const docker = new SingleOutputThenSilentDockerRunner(50);
  const { manager, store } = createManager(createRuntimeConfig(root), docker, {
    heartbeatIntervalMs: 20,
  });

  const job = await createJob(manager, 'codex');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  const log = await readFile(finished.artifacts.logPath, 'utf8');

  assert.match(log, /initial output/);
  assert.match(log, /\[agent-runner\] still running; waiting for agent output/);

  clearAuthEnv();
});

test('job manager forwards proxy env to git clone and getDefaultBranch for enterprise hosts', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-proxy-forward-'));
  const docker = new MockDockerRunner();
  const git = new MockGitManager();
  const config = createRuntimeConfig(root);
  const store = new JobStore(config);
  const events = new JobEvents();
  const manager = new JobManager(
    config,
    store,
    events,
    git as never,
    docker as never,
    new AgentAdapters(),
    new AgentStateAuditor(config),
    new BrokerLeaseStore(config),
    new DockerBroker(config),
    new McpBroker(config),
    new SecurityAuditLogger(),
    { runMode: 'inline' },
  );

  const job = await manager.createJob({
    repoUrl: 'git@github.a8c.com:owner/repo.git',
    specPath: 'agent-os/specs/example',
    agentRuntime: 'claude',
    effort: 'auto',
    githubHost: 'github.a8c.com',
    commitOnStop: true,
    wpEnvEnabled: true,
    capabilityProfile: 'dangerous',
    repoAccessMode: 'ambient',
    agentStateMode: 'mounted',
  });

  await waitForJob(store, job.id, [ 'completed' ]);

  assert.ok(git.lastCloneEnv, 'cloneRepository should receive proxy env');
  assert.equal(git.lastCloneEnv.HTTPS_PROXY, 'socks5://127.0.0.1:8080');

  assert.ok(git.lastDefaultBranchEnv, 'getDefaultBranch should receive proxy env');
  assert.equal(git.lastDefaultBranchEnv.HTTPS_PROXY, 'socks5://127.0.0.1:8080');

  clearAuthEnv();
});

test('job manager does not pass proxy env for github.com jobs', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-no-proxy-'));
  const docker = new MockDockerRunner();
  const git = new MockGitManager();
  const config = createRuntimeConfig(root);
  const store = new JobStore(config);
  const events = new JobEvents();
  const manager = new JobManager(
    config,
    store,
    events,
    git as never,
    docker as never,
    new AgentAdapters(),
    new AgentStateAuditor(config),
    new BrokerLeaseStore(config),
    new DockerBroker(config),
    new McpBroker(config),
    new SecurityAuditLogger(),
    { runMode: 'inline' },
  );

  const job = await createJob(manager, 'claude');
  await waitForJob(store, job.id, [ 'completed' ]);

  assert.equal(git.lastCloneEnv, undefined, 'cloneRepository should not receive proxy env for github.com');
  assert.equal(git.lastDefaultBranchEnv, undefined, 'getDefaultBranch should not receive proxy env for github.com');

  clearAuthEnv();
});

test('runJob calls ensureBroker after acquiring lock and broker.close() in finally', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-lifecycle-'));
  const docker = new MockDockerRunner();
  const callOrder: string[] = [];
  const mockBroker: BrokerHandle = {
    async close() { callOrder.push('broker.close'); },
  };
  const { manager, store } = createManager(createRuntimeConfig(root), docker, {
    ensureBroker: async () => {
      callOrder.push('ensureBroker');
      return mockBroker;
    },
  });

  const job = await createJob(manager, 'claude');
  await waitForJob(store, job.id, [ 'completed' ]);

  // Allow the runJob finally block (which calls broker.close) to settle after
  // the job status transitions to completed inside executeJob.
  for (let i = 0; i < 50 && !callOrder.includes('broker.close'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(callOrder.includes('ensureBroker'), 'ensureBroker should be called');
  assert.ok(callOrder.includes('broker.close'), 'broker.close should be called');
  assert.ok(
    callOrder.indexOf('ensureBroker') < callOrder.indexOf('broker.close'),
    'ensureBroker should be called before broker.close',
  );

  clearAuthEnv();
});

test('runJob fails gracefully and releases lock when ensureBroker throws', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-throw-'));
  const docker = new MockDockerRunner();
  const config = createRuntimeConfig(root);
  const { manager, store } = createManager(config, docker, {
    ensureBroker: async () => {
      throw new Error('Broker unavailable');
    },
  });

  const job = await createJob(manager, 'claude');
  const failed = await waitForJob(store, job.id, [ 'failed' ]);

  assert.equal(failed.status, 'failed');
  assert.match(failed.blockerReason ?? '', /Broker unavailable/);
  assert.equal(docker.runCount, 0, 'docker should not have been invoked');
  assert.equal(await pathExists(path.join(config.appDir, 'active-job.lock')), false, 'lock should be released');

  clearAuthEnv();
});

test('runJob releases lock even when broker.close() throws', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-close-throw-'));
  const docker = new MockDockerRunner();
  const config = createRuntimeConfig(root);
  const { manager, store } = createManager(config, docker, {
    ensureBroker: async () => ({
      async close() { throw new Error('close kaboom'); },
    }),
  });

  const job = await createJob(manager, 'claude');
  await waitForJob(store, job.id, [ 'completed' ]);

  // broker.close() threw, but the lock must still be released.
  assert.equal(
    await pathExists(path.join(config.appDir, 'active-job.lock')),
    false,
    'lock should be released even when broker.close() throws',
  );

  clearAuthEnv();
});

test('runJob works when ensureBroker is not provided', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-no-broker-'));
  const docker = new MockDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);

  assert.equal(finished.status, 'completed');

  clearAuthEnv();
});
