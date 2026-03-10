import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { JobRecord, JobSummaryArtifact } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { RuntimeConfig } from '../server/config.js';
import type { RuntimeContext } from '../server/runtime.js';

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
      capabilityProfile: 'dangerous',
      repoAccessMode: 'ambient',
      agentStateMode: 'mounted',
    },
    status: 'completed',
    workspacePath: path.join(config.workspacesDir, 'job-123', 'repo'),
    branchName: 'agent-runner/job-123',
    headSha: 'abc123',
    createdAt: '2026-03-08T10:00:00.000Z',
    updatedAt: '2026-03-08T10:05:00.000Z',
    artifacts: {
      logPath: path.join(artifactDir, 'run.log'),
      debugLogPath: path.join(artifactDir, 'outputs', 'debug.log'),
      securityAuditPath: path.join(artifactDir, 'security-audit.jsonl'),
      progressEventsPath: path.join(artifactDir, 'outputs', 'progress.ndjson'),
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
  const manager = {
    async listJobs(): Promise<JobRecord[]> {
      return [ record ];
    },
    async createJob(): Promise<JobRecord> {
      return record;
    },
    async getJob(jobId: string): Promise<JobRecord | null> {
      return jobId === record.id ? record : null;
    },
    async cancelJob(): Promise<JobRecord> {
      return record;
    },
    async readLog(): Promise<string> {
      return '';
    },
  };

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
    securityAuditLogger: {} as RuntimeContext['securityAuditLogger'],
    manager: manager as RuntimeContext['manager'],
  };
}

async function withServer<T>(runtime: RuntimeContext, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const { app } = createApp(runtime);
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

test('artifact route returns parsed summary payload for the viewer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-app-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  const summary: JobSummaryArtifact = {
    id: record.id,
    status: 'completed',
    summary: 'Implemented the requested UI changes.',
    blockerReason: null,
    branchName: record.branchName,
    changedFiles: [ 'M src/client/App.tsx' ],
    headSha: record.headSha,
    finishedAt: '2026-03-08T10:05:00.000Z',
    debugCommand: 'docker exec -it container-123 bash',
    workspacePath: record.workspacePath,
    specPath: record.spec.specPath,
    sourceSpecPath: '/workspace/agent-os/specs/example',
    resolvedSpec: undefined,
  };

  await mkdir(path.dirname(record.artifacts.summaryPath), { recursive: true });
  await writeFile(record.artifacts.summaryPath, JSON.stringify(summary), 'utf8');

  await withServer(createRuntime(config, record), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/${record.id}/artifacts/summary`);
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      artifactId: string;
      label: string;
      available: boolean;
      summary?: { summary?: string };
    };

    assert.equal(payload.artifactId, 'summary');
    assert.equal(payload.label, 'summary');
    assert.equal(payload.available, true);
    assert.equal(payload.summary?.summary, summary.summary);
  });
});

test('artifact route returns raw final response content for the viewer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-app-final-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  const finalResponse = JSON.stringify({
    status: 'completed',
    summary: 'done',
    blockerReason: null,
  });

  await mkdir(path.dirname(record.artifacts.finalResponsePath), { recursive: true });
  await writeFile(record.artifacts.finalResponsePath, finalResponse, 'utf8');

  await withServer(createRuntime(config, record), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/${record.id}/artifacts/finalResponse`);
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      artifactId: string;
      label: string;
      available: boolean;
      content: string;
    };

    assert.equal(payload.artifactId, 'finalResponse');
    assert.equal(payload.label, 'final response');
    assert.equal(payload.available, true);
    assert.equal(payload.content, finalResponse);
  });
});

test('artifact route reports missing artifacts without failing the viewer request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-app-missing-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);

  await mkdir(path.dirname(record.artifacts.summaryPath), { recursive: true });

  await withServer(createRuntime(config, record), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs/${record.id}/artifacts/gitDiff`);
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      artifactId: string;
      available: boolean;
      content: string;
    };

    assert.equal(payload.artifactId, 'gitDiff');
    assert.equal(payload.available, false);
    assert.equal(payload.content, '');
  });
});
