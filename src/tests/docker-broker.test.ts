import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import { DockerBroker } from '../server/docker-broker.js';

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
    uiSessionToken: 'session-token',
  };
}

function createJobRecord(root: string): JobRecord {
  const artifactDir = path.join(root, 'artifacts', 'job-123');
  return {
    id: 'job-123',
    status: 'running',
    branchName: 'agent-runner/job-123',
    workspacePath: path.join(root, 'workspaces', 'job-123', 'repo'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: {
      repoUrl: 'git@github.com:owner/repo.git',
      specPath: 'agent-os/specs/example',
      agentRuntime: 'codex',
      effort: 'auto',
      githubHost: 'github.com',
      commitOnStop: true,
      wpEnvEnabled: true,
      capabilityProfile: 'docker-broker',
      repoAccessMode: 'broker',
      agentStateMode: 'mounted',
    },
    artifacts: {
      logPath: path.join(artifactDir, 'run.log'),
      debugLogPath: path.join(artifactDir, 'outputs', 'debug.log'),
      summaryPath: path.join(artifactDir, 'summary.json'),
      gitDiffPath: path.join(artifactDir, 'git.diff'),
      agentTranscriptPath: path.join(artifactDir, 'agent-transcript.log'),
      finalResponsePath: path.join(artifactDir, 'outputs', 'final-response.json'),
      schemaPath: path.join(artifactDir, 'inputs', 'result-schema.json'),
      promptPath: path.join(artifactDir, 'inputs', 'prompt.txt'),
      specBundlePath: path.join(artifactDir, 'spec'),
      inputsDir: path.join(artifactDir, 'inputs'),
      outputsDir: path.join(artifactDir, 'outputs'),
      agentStateSummaryPath: path.join(artifactDir, 'agent-state-summary.json'),
      agentStateDiffPath: path.join(artifactDir, 'agent-state.diff'),
    },
  };
}

test('docker broker labels and tracks brokered container runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-docker-broker-'));
  const config = createRuntimeConfig(root);
  const record = createJobRecord(root);
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

  const broker = new DockerBroker(config, async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });

    if (command === 'docker' && args[0] === 'run') {
      return { stdout: 'container-xyz\n', stderr: '', exitCode: 0 };
    }

    if (command === 'docker' && args[0] === 'ps') {
      return { stdout: 'container-xyz\n', stderr: '', exitCode: 0 };
    }

    if (command === 'docker' && args[0] === 'network') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (command === 'docker' && args[0] === 'volume') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.containerRun(record, [ '--detach', 'nginx:latest' ]);
  const state = await broker.getTrackedState(record.id);

  assert.ok(calls.some((call) => call.command === 'docker' && call.args.includes('--label') && call.args.includes('agent-runner.job=job-123')));
  assert.ok(state);
  assert.deepEqual(state?.containers, [ 'container-xyz' ]);
});

test('docker broker rejects workspace-external bind mounts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-docker-broker-reject-'));
  const config = createRuntimeConfig(root);
  const record = createJobRecord(root);
  const broker = new DockerBroker(config);

  await assert.rejects(
    () => broker.containerRun(record, [ '/etc/passwd:/data', 'alpine' ]),
    /escapes workspace/,
  );
});

test('docker broker cleanup removes tracked resources and clears state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-docker-broker-cleanup-'));
  const config = createRuntimeConfig(root);
  const record = createJobRecord(root);
  const calls: Array<{ command: string; args: string[] }> = [];

  const broker = new DockerBroker(config, async (command, args, options = {}) => {
    calls.push({ command, args });

    if (command === 'docker' && args[0] === 'ps') {
      return { stdout: 'container-123\n', stderr: '', exitCode: 0 };
    }

    if (command === 'docker' && args[0] === 'network') {
      return { stdout: 'network-123\n', stderr: '', exitCode: 0 };
    }

    if (command === 'docker' && args[0] === 'volume') {
      return { stdout: 'volume-123\n', stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.containerRun(record, [ '--detach', 'nginx:latest' ]);
  await broker.cleanupJob(record);
  const state = await broker.getTrackedState(record.id);

  assert.ok(calls.some((call) => call.args.join(' ').includes('compose -p agent-runner-job123 down --volumes --remove-orphans')));
  assert.ok(calls.some((call) => call.args.slice(0, 3).join(' ') === 'rm -f container-123'));
  assert.ok(calls.some((call) => call.args.slice(0, 3).join(' ') === 'network rm network-123'));
  assert.ok(calls.some((call) => call.args.slice(0, 4).join(' ') === 'volume rm -f volume-123'));
  assert.deepEqual(state?.containers ?? [], []);
  assert.deepEqual(state?.networks ?? [], []);
  assert.deepEqual(state?.volumes ?? [], []);
});

test('docker broker restricts compose exec to owned services', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-docker-broker-exec-'));
  const config = createRuntimeConfig(root);
  const record = createJobRecord(root);
  const broker = new DockerBroker(config, async (command, args) => {
    if (command === 'docker' && args[0] === 'ps') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await assert.rejects(
    () => broker.composeExec(record, 'wordpress', [ 'php', '-v' ]),
    /not owned by job/,
  );
});
