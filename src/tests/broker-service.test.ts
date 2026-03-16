import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JobRecord } from '../shared/types.js';
import { ensureBrokerService, isBrokerReachable, runWithBrokerService } from '../server/broker-service.js';
import type { RuntimeConfig } from '../server/config.js';
import type { RuntimeContext } from '../server/runtime.js';
import { SecurityAuditLogger } from '../server/security-audit-log.js';

function createRuntimeConfig(root: string, brokerPort: number): RuntimeConfig {
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
    brokerPort,
    brokerHost: 'host.docker.internal',
    brokerUrl: `http://host.docker.internal:${brokerPort}`,
  };
}

function createRecord(config: RuntimeConfig, profile: JobRecord['spec']['capabilityProfile'] = 'docker-broker'): JobRecord {
  const artifactDir = path.join(config.artifactsDir, 'job-123');

  return {
    id: 'job-123',
    spec: {
      repoUrl: 'git@github.com:owner/repo.git',
      specPath: 'agent-os/specs/example',
      agentRuntime: 'claude',
      effort: 'auto',
      githubHost: 'github.com',
      commitOnStop: true,
      wpEnvEnabled: true,
      capabilityProfile: profile,
      repoAccessMode: profile === 'dangerous' ? 'ambient' : 'broker',
      agentStateMode: 'mounted',
    },
    status: 'running',
    workspacePath: path.join(config.workspacesDir, 'job-123', 'repo'),
    branchName: 'agent-runner/job-123',
    defaultBranch: 'main',
    createdAt: '2026-03-08T10:00:00.000Z',
    updatedAt: '2026-03-08T10:05:00.000Z',
    artifacts: {
      logPath: path.join(artifactDir, 'run.log'),
      debugLogPath: path.join(artifactDir, 'outputs', 'debug.log'),
      securityAuditPath: path.join(artifactDir, 'security-audit.jsonl'),
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

function createRuntime(config: RuntimeConfig, record: JobRecord): RuntimeContext {
  return {
    config,
    events: {} as RuntimeContext['events'],
    store: {} as RuntimeContext['store'],
    git: {} as RuntimeContext['git'],
    docker: {} as RuntimeContext['docker'],
    adapters: {} as RuntimeContext['adapters'],
    agentStateAuditor: {} as RuntimeContext['agentStateAuditor'],
    brokerLeaseStore: {} as RuntimeContext['brokerLeaseStore'],
    repoBroker: {} as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };
}

test('ensureBrokerService starts a reachable broker and closes it cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-service-'));
  const brokerPort = await reservePort();
  const config = createRuntimeConfig(root, brokerPort);
  const runtime = createRuntime(config, createRecord(config));

  const broker = await ensureBrokerService(runtime);
  assert.equal(await isBrokerReachable(brokerPort), true);

  await broker.close();

  assert.equal(await isBrokerReachable(brokerPort), false);
});

test('runWithBrokerService scopes broker lifetime to brokered internal runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-run-'));
  const brokerPort = await reservePort();
  const config = createRuntimeConfig(root, brokerPort);
  const runtime = createRuntime(config, createRecord(config, 'repo-broker'));

  let reachableDuringTask = false;
  await runWithBrokerService(runtime, 'job-123', async () => {
    reachableDuringTask = await isBrokerReachable(brokerPort);
  });

  assert.equal(reachableDuringTask, true);
  assert.equal(await isBrokerReachable(brokerPort), false);
});

test('runWithBrokerService starts broker for safe-profile jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-safe-'));
  const brokerPort = await reservePort();
  const config = createRuntimeConfig(root, brokerPort);
  const runtime = createRuntime(config, createRecord(config, 'safe'));

  let reachableDuringTask = false;
  await runWithBrokerService(runtime, 'job-123', async () => {
    reachableDuringTask = await isBrokerReachable(brokerPort);
  });

  assert.equal(reachableDuringTask, true);
  assert.equal(await isBrokerReachable(brokerPort), false);
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to reserve port');
  }
  const port = (address as AddressInfo).port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  return port;
}
