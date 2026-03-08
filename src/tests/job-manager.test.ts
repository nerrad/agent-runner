import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AgentResult, JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import type { DockerRunRequest } from '../server/docker-runner.js';
import { pathExists } from '../server/fs-utils.js';
import { JobStore } from '../server/job-store.js';
import { JobEvents } from '../server/job-events.js';
import type { JobManagerOptions } from '../server/job-manager.js';
import { JobManager } from '../server/job-manager.js';
import { AgentAdapters } from '../server/agent-adapters.js';

const AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AGENT_RUNNER_ANTHROPIC_KEY_HELPER',
  'AGENT_RUNNER_OPENAI_KEY_HELPER',
  'AGENT_RUNNER_DISABLE_KEYCHAIN_LOOKUP',
] as const;

class MockGitManager {
  public changedFiles = [ ' M src/index.ts' ];
  public headSha = 'abc123';

  async cloneRepository(_repoUrl: string, workspacePath: string): Promise<void> {
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, '.gitkeep'), '', 'utf8');
    await mkdir(path.join(workspacePath, 'agent-os', 'specs', 'example'), { recursive: true });
    await writeFile(path.join(workspacePath, 'agent-os', 'specs', 'example', 'plan.md'), '# Plan\n', 'utf8');
    await writeFile(path.join(workspacePath, 'agent-os', 'specs', 'example', 'shape.md'), '# Shape\n', 'utf8');
  }

  async createBranch(): Promise<void> {}
  async getHeadSha(): Promise<string> { return this.headSha; }
  async getChangedFiles(): Promise<string[]> { return this.changedFiles; }
  async commitAll(): Promise<boolean> { return true; }
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
): { manager: JobManager; store: JobStore } {
  const store = new JobStore(config);
  const manager = new JobManager(
    config,
    store,
    new JobEvents(),
    new MockGitManager() as never,
    docker as never,
    new AgentAdapters(),
    {
      runMode: 'inline',
      ...options,
    },
  );

  return { manager, store };
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

  assert.equal(finished.status, 'completed');
  assert.equal(finished.containerId, 'container-123');
  assert.equal(docker.lastEnv?.ANTHROPIC_API_KEY, 'test-anthropic-key');
  assert.match(finished.debugCommand ?? '', /docker exec -it container-123 bash/);
  assert.equal(finished.headSha, 'abc123');
  assert.equal(finished.resolvedSpec?.specMode, 'bundle');
  assert.deepEqual(finished.resolvedSpec?.specFiles, [ '/spec/plan.md', '/spec/shape.md' ]);
  assert.match(log, /\[agent-runner\] cloning repository/);
  assert.match(log, /\[agent-runner\] bootstrapping workspace and staging spec bundle/);
  assert.match(log, /\[agent-runner\] building worker image and launching agent/);
  assert.match(log, /\[agent-runner\] container started: container-123/);
  assert.match(log, /\[agent-runner\] job completed/);

  clearAuthEnv();
});

test('helper auth is used when direct claude env is absent and secrets are not logged', async () => {
  clearAuthEnv();
  process.env.AGENT_RUNNER_ANTHROPIC_KEY_HELPER = 'printf helper-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-helper-'));
  const docker = new MockDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  const log = await readFile(finished.artifacts.logPath, 'utf8');

  assert.equal(finished.status, 'completed');
  assert.equal(docker.lastEnv?.ANTHROPIC_API_KEY, 'helper-anthropic-key');
  assert.doesNotMatch(log, /helper-anthropic-key/);

  clearAuthEnv();
});

test('automatic claude helper from claude settings resolves a key when env auth is absent', async () => {
  clearAuthEnv();

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-auto-claude-helper-'));
  const config = createRuntimeConfig(root);
  await mkdir(config.claudeDir, { recursive: true });
  await writeFile(path.join(config.claudeDir, 'settings.json'), JSON.stringify({
    apiKeyHelper: 'printf auto-claude-key',
  }), 'utf8');

  const docker = new MockDockerRunner();
  const { manager, store } = createManager(config, docker);

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  const log = await readFile(finished.artifacts.logPath, 'utf8');

  assert.equal(finished.status, 'completed');
  assert.equal(docker.lastEnv?.ANTHROPIC_API_KEY, 'auto-claude-key');
  assert.doesNotMatch(log, /auto-claude-key/);
});

test('direct env auth takes precedence over a failing helper', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'preferred-anthropic-key';
  process.env.AGENT_RUNNER_ANTHROPIC_KEY_HELPER = 'exit 9';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-helper-precedence-'));
  const docker = new MockDockerRunner();
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);

  assert.equal(finished.status, 'completed');
  assert.equal(docker.lastEnv?.ANTHROPIC_API_KEY, 'preferred-anthropic-key');

  clearAuthEnv();
});

test('claude jobs fail before docker launch when no auth is available', async () => {
  clearAuthEnv();
  process.env.AGENT_RUNNER_DISABLE_KEYCHAIN_LOOKUP = '1';

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

test('claude jobs fail before docker launch when automatic helper returns no usable key', async () => {
  clearAuthEnv();
  process.env.AGENT_RUNNER_DISABLE_KEYCHAIN_LOOKUP = '1';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-empty-helper-'));
  const config = createRuntimeConfig(root);
  await mkdir(config.claudeDir, { recursive: true });
  await writeFile(path.join(config.claudeDir, 'settings.json'), JSON.stringify({
    apiKeyHelper: 'printf ""',
  }), 'utf8');

  const docker = new MockDockerRunner();
  const { manager } = createManager(config, docker);

  const job = await createJob(manager, 'claude');

  assert.equal(job.status, 'failed');
  assert.equal(docker.runCount, 0);
});

test('codex jobs automatically resolve OPENAI_API_KEY from host auth state when env auth is absent', async () => {
  clearAuthEnv();

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-codex-fallback-'));
  const config = createRuntimeConfig(root);
  await mkdir(config.codexDir, { recursive: true });
  await writeFile(path.join(config.codexDir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'codex-auth-file-key',
  }), 'utf8');

  const docker = new MockDockerRunner();
  const { manager, store } = createManager(config, docker);

  const job = await createJob(manager, 'codex');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);

  assert.equal(finished.status, 'completed');
  assert.equal(docker.lastEnv?.OPENAI_API_KEY, 'codex-auth-file-key');
});

test('codex jobs fail before docker launch when no key can be automatically resolved', async () => {
  clearAuthEnv();
  process.env.AGENT_RUNNER_DISABLE_KEYCHAIN_LOOKUP = '1';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-no-codex-auth-'));
  const docker = new MockDockerRunner();
  const { manager } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'codex');

  assert.equal(job.status, 'failed');
  assert.match(job.blockerReason ?? '', /OPENAI_API_KEY/);
  assert.equal(docker.runCount, 0);
});

test('repeated claude auth failures with no meaningful output stop the container and fail the job', async () => {
  clearAuthEnv();
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-auth-loop-'));
  const docker = new ScriptedDockerRunner([
    'authentication_failed\n',
    'Please run /login\n',
    'Not logged in\n',
  ], null, 137);
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'claude');
  const failed = await waitForJob(store, job.id, [ 'failed' ]);
  const log = await readFile(failed.artifacts.logPath, 'utf8');

  assert.equal(docker.stoppedContainerId, 'container-scripted');
  assert.match(failed.blockerReason ?? '', /infinite auth loop/i);
  assert.match(log, /infinite auth loop/i);

  clearAuthEnv();
});

test('auth errors after meaningful output do not trigger the loop abort', async () => {
  clearAuthEnv();
  process.env.OPENAI_API_KEY = 'test-openai-key';

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-auth-noise-'));
  const docker = new ScriptedDockerRunner([
    'Planning change set\n',
    '401 Unauthorized\n',
    'Please run codex --login\n',
    'OPENAI_API_KEY\n',
  ], {
    status: 'completed',
    summary: 'done',
  });
  const { manager, store } = createManager(createRuntimeConfig(root), docker);

  const job = await createJob(manager, 'codex');
  const finished = await waitForJob(store, job.id, [ 'completed' ]);

  assert.equal(finished.status, 'completed');
  assert.equal(docker.stoppedContainerId, null);

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
