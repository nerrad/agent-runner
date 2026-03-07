import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import { JobStore } from '../server/job-store.js';
import { JobEvents } from '../server/job-events.js';
import { JobManager } from '../server/job-manager.js';
import { AgentAdapters } from '../server/agent-adapters.js';

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
  public pendingResolve: (() => void) | null = null;

  async ensureImageBuilt(): Promise<void> {}

  async runJob(request: {
    job: JobRecord;
    onStart?: (containerId: string) => Promise<void> | void;
    onLog: (chunk: string) => Promise<void> | void;
  }): Promise<{ containerId: string; exitCode: number }> {
    await request.onStart?.('container-123');
    await request.onLog('starting\n');
    await writeFile(request.job.artifacts.finalResponsePath, JSON.stringify({
      status: 'completed',
      summary: 'done',
    }), 'utf8');
    return {
      containerId: 'container-123',
      exitCode: 0,
    };
  }

  async stopJob(containerId: string): Promise<void> {
    this.stoppedContainerId = containerId;
    this.pendingResolve?.();
  }

  createDebugCommand(record: JobRecord): string {
    return `docker exec -it ${record.containerId} bash`;
  }

  async appendTranscript(): Promise<void> {}
}

class BlockingDockerRunner extends MockDockerRunner {
  override async runJob(request: {
    job: JobRecord;
    onStart?: (containerId: string) => Promise<void> | void;
    onLog: (chunk: string) => Promise<void> | void;
  }): Promise<{ containerId: string; exitCode: number }> {
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
    sshAuthSock: '/tmp/ssh.sock',
    githubProxyUrl: 'socks5://host.docker.internal:8080',
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: path.resolve(new URL('../..', import.meta.url).pathname),
  };
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

test('job manager processes a job through completion and writes commit metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-jobs-'));
  const config = createRuntimeConfig(root);
  const store = new JobStore(config);
  const events = new JobEvents();
  const git = new MockGitManager();
  const docker = new MockDockerRunner();
  const manager = new JobManager(config, store, events, git as never, docker as never, new AgentAdapters(), {
    runMode: 'inline',
  });

  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

  const job = await manager.createJob({
    repoUrl: 'git@github.com:owner/repo.git',
    specPath: 'agent-os/specs/example',
    agentRuntime: 'claude',
    githubHost: 'github.com',
    commitOnStop: true,
    wpEnvEnabled: true,
  });

  const finished = await waitForJob(store, job.id, [ 'completed' ]);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.containerId, 'container-123');
  assert.match(finished.debugCommand ?? '', /docker exec -it container-123 bash/);
  assert.equal(finished.headSha, 'abc123');
  assert.equal(finished.resolvedSpec?.specMode, 'bundle');
  assert.deepEqual(finished.resolvedSpec?.specFiles, [ '/spec/plan.md', '/spec/shape.md' ]);
});

test('cancelJob stops the active container and keeps canceled state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cancel-'));
  const config = createRuntimeConfig(root);
  const store = new JobStore(config);
  const events = new JobEvents();
  const git = new MockGitManager();
  const docker = new BlockingDockerRunner();
  const manager = new JobManager(config, store, events, git as never, docker as never, new AgentAdapters(), {
    runMode: 'inline',
  });

  process.env.OPENAI_API_KEY = 'test-openai-key';

  const job = await manager.createJob({
    repoUrl: 'git@github.com:owner/repo.git',
    specPath: 'agent-os/specs/example',
    agentRuntime: 'codex',
    githubHost: 'github.com',
    commitOnStop: true,
    wpEnvEnabled: true,
  });

  const running = await waitForJobWithContainer(store, job.id);
  assert.equal(running.containerId, 'container-blocking');

  await manager.cancelJob(job.id);

  const canceled = await waitForJob(store, job.id, [ 'canceled' ]);
  assert.equal(canceled.status, 'canceled');
  assert.equal(docker.stoppedContainerId, 'container-blocking');
});
