import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { JobRecord } from '../shared/types.js';
import { createBrokerApp } from '../server/broker-app.js';
import type { RuntimeConfig } from '../server/config.js';
import type { RuntimeContext } from '../server/runtime.js';
import { SecurityAuditLogger } from '../server/security-audit-log.js';

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

function createRecord(config: RuntimeConfig): JobRecord {
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
      capabilityProfile: 'repo-broker',
      repoAccessMode: 'broker',
      agentStateMode: 'mounted',
    },
    status: 'running',
    workspacePath: path.join(config.workspacesDir, 'job-123', 'repo'),
    branchName: 'agent-runner/job-123',
    defaultBranch: 'main',
    headSha: 'abc123',
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

async function withServer<T>(runtime: RuntimeContext, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createBrokerApp(runtime);
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind test server');
    }
    return await run(`http://127.0.0.1:${(address as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test('broker app writes a security audit entry for blocked broker activity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-app-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  const runtime: RuntimeContext = {
    config,
    events: {} as RuntimeContext['events'],
    store: {} as RuntimeContext['store'],
    git: {} as RuntimeContext['git'],
    docker: {} as RuntimeContext['docker'],
    adapters: {} as RuntimeContext['adapters'],
    agentStateAuditor: {} as RuntimeContext['agentStateAuditor'],
    brokerLeaseStore: {
      async validate() {
        return {
          jobId: record.id,
          token: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {
      async runGitRead() {
        throw new Error('Blocked for test');
      },
    } as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/repo/git-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'valid-token',
        args: [ 'status' ],
      }),
    });

    assert.equal(response.status, 400);
  });

  const log = await readFile(record.artifacts.securityAuditPath, 'utf8');
  const entry = JSON.parse(log.trim()) as { subsystem: string; action: string; reason: string };
  assert.equal(entry.subsystem, 'repo-broker');
  assert.equal(entry.action, 'git-read');
  assert.match(entry.reason, /Blocked for test/);
});
