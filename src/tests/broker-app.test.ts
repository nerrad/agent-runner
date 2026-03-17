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
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async validateRename() {
        return {
          jobId: record.id,
          token: 'valid-token',
          renameToken: 'valid-token',
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
    mcpBroker: {} as RuntimeContext['mcpBroker'],
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

test('broker app rename-branch endpoint updates record and returns success', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-app-rename-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  let savedRecord: JobRecord | null = null;
  let emittedRecord: JobRecord | null = null;

  const runtime: RuntimeContext = {
    config,
    events: {
      emitRecord(r: JobRecord) {
        emittedRecord = r;
      },
    } as RuntimeContext['events'],
    store: {
      async save(r: JobRecord) {
        savedRecord = r;
      },
    } as RuntimeContext['store'],
    git: {} as RuntimeContext['git'],
    docker: {} as RuntimeContext['docker'],
    adapters: {} as RuntimeContext['adapters'],
    agentStateAuditor: {} as RuntimeContext['agentStateAuditor'],
    brokerLeaseStore: {
      async validate() {
        return {
          jobId: record.id,
          token: 'valid-token',
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async validateRename() {
        return {
          jobId: record.id,
          token: 'valid-token',
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {
      async renameBranch() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    } as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    mcpBroker: {} as RuntimeContext['mcpBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/repo/rename-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'valid-token',
        branchName: 'feature/renamed',
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(savedRecord);
    assert.equal((savedRecord as JobRecord).branchName, 'feature/renamed');
    assert.ok(emittedRecord);
    assert.equal((emittedRecord as JobRecord).branchName, 'feature/renamed');
  });
});

test('broker app rename-branch endpoint does not update record on git failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-app-rename-fail-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  let savedRecord: JobRecord | null = null;

  const runtime: RuntimeContext = {
    config,
    events: {
      emitRecord() {},
    } as RuntimeContext['events'],
    store: {
      async save(r: JobRecord) {
        savedRecord = r;
      },
    } as RuntimeContext['store'],
    git: {} as RuntimeContext['git'],
    docker: {} as RuntimeContext['docker'],
    adapters: {} as RuntimeContext['adapters'],
    agentStateAuditor: {} as RuntimeContext['agentStateAuditor'],
    brokerLeaseStore: {
      async validate() {
        return {
          jobId: record.id,
          token: 'valid-token',
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async validateRename() {
        return {
          jobId: record.id,
          token: 'valid-token',
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {
      async renameBranch() {
        return { stdout: '', stderr: 'error: refname is ambiguous', exitCode: 128 };
      },
    } as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    mcpBroker: {} as RuntimeContext['mcpBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/repo/rename-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'valid-token',
        branchName: 'feature/renamed',
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(savedRecord, null);
  });
});

test('broker app exposes wp-env commands for docker-broker jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-app-wp-env-'));
  const config = createRuntimeConfig(root);
  const record = {
    ...createRecord(config),
    spec: {
      ...createRecord(config).spec,
      capabilityProfile: 'docker-broker' as const,
    },
  };
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
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
      async validateRename() {
        return {
          jobId: record.id,
          token: 'valid-token',
          renameToken: 'valid-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {} as RuntimeContext['repoBroker'],
    dockerBroker: {
      async wpEnv(_record, subcommand, args) {
        return {
          stdout: `wp-env ${subcommand} ${args.join(' ')}`.trim(),
          stderr: '',
          exitCode: 0,
        };
      },
    } as RuntimeContext['dockerBroker'],
    mcpBroker: {} as RuntimeContext['mcpBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/wp-env/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'valid-token',
        args: [ '--xdebug' ],
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { stdout: string; exitCode: number };
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.stdout, 'wp-env start --xdebug');
  });
});

test('broker app rename-branch endpoint succeeds for safe-profile job with rename token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-app-safe-rename-'));
  const config = createRuntimeConfig(root);
  const record = {
    ...createRecord(config),
    spec: {
      ...createRecord(config).spec,
      capabilityProfile: 'safe' as const,
      repoAccessMode: 'none' as const,
    },
  };
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  let savedRecord: JobRecord | null = null;

  const runtime: RuntimeContext = {
    config,
    events: {
      emitRecord(r: JobRecord) {
        savedRecord = r;
      },
    } as RuntimeContext['events'],
    store: {
      async save(r: JobRecord) {
        savedRecord = r;
      },
    } as RuntimeContext['store'],
    git: {} as RuntimeContext['git'],
    docker: {} as RuntimeContext['docker'],
    adapters: {} as RuntimeContext['adapters'],
    agentStateAuditor: {} as RuntimeContext['agentStateAuditor'],
    brokerLeaseStore: {
      async validate() {
        throw new Error('Invalid broker lease');
      },
      async validateRename() {
        return {
          jobId: record.id,
          token: 'full-token',
          renameToken: 'rename-only-token',
          repoUrl: record.spec.repoUrl,
          profile: record.spec.capabilityProfile,
          branchName: record.branchName,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {
      async renameBranch() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    } as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    mcpBroker: {} as RuntimeContext['mcpBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/repo/rename-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'rename-only-token',
        branchName: 'feature/safe-renamed',
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(savedRecord);
    assert.equal((savedRecord as JobRecord).branchName, 'feature/safe-renamed');
  });
});

test('broker app git-read endpoint rejects safe-profile job with rename-only token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-app-safe-gitread-'));
  const config = createRuntimeConfig(root);
  const record = {
    ...createRecord(config),
    spec: {
      ...createRecord(config).spec,
      capabilityProfile: 'safe' as const,
      repoAccessMode: 'none' as const,
    },
  };
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
        throw new Error('Invalid broker lease');
      },
      async validateRename() {
        throw new Error('Invalid broker lease');
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {} as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    mcpBroker: {} as RuntimeContext['mcpBroker'],
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
        token: 'rename-only-token',
        args: [ 'status' ],
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /Invalid broker lease/);
  });
});

// ── MCP Broker Route Tests ──────────────────────────────────────────

function createMcpRuntime(config: RuntimeConfig, record: JobRecord, overrides?: {
  validate?: () => Promise<unknown>;
  validateRename?: () => Promise<unknown>;
  mcpBroker?: Partial<RuntimeContext['mcpBroker']>;
}): RuntimeContext {
  return {
    config,
    events: {} as RuntimeContext['events'],
    store: {} as RuntimeContext['store'],
    git: {} as RuntimeContext['git'],
    docker: {} as RuntimeContext['docker'],
    adapters: {} as RuntimeContext['adapters'],
    agentStateAuditor: {} as RuntimeContext['agentStateAuditor'],
    brokerLeaseStore: {
      async validate() {
        if (overrides?.validate) return overrides.validate();
        return { jobId: record.id, token: 'valid-token', renameToken: 'rename-token' };
      },
      async validateRename() {
        if (overrides?.validateRename) return overrides.validateRename();
        return { jobId: record.id, token: 'valid-token', renameToken: 'rename-token' };
      },
    } as RuntimeContext['brokerLeaseStore'],
    repoBroker: {} as RuntimeContext['repoBroker'],
    dockerBroker: {} as RuntimeContext['dockerBroker'],
    mcpBroker: {
      async ensureProcess() { return { alive: true, pid: 123, name: 'test-server' }; },
      handleSseConnection(_jobId: string, _serverName: string, res: import('express').Response) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write('event: endpoint\ndata: http://example.com/message\n\n');
        res.end();
      },
      async handleMessage() {},
      getJobStatus() { return { servers: [{ name: 'test-server', pid: 123, alive: true }] }; },
      ...overrides?.mcpBroker,
    } as RuntimeContext['mcpBroker'],
    securityAuditLogger: new SecurityAuditLogger(),
    manager: {
      async getJob(jobId: string) {
        return jobId === record.id ? record : null;
      },
    } as RuntimeContext['manager'],
  };
}

test('broker app MCP status endpoint returns server status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-mcp-status-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  const runtime = createMcpRuntime(config, record);

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/mcp/status?token=valid-token`);
    assert.equal(response.status, 200);
    const body = await response.json() as { servers: Array<{ name: string; alive: boolean }> };
    assert.equal(body.servers.length, 1);
    assert.equal(body.servers[0].name, 'test-server');
    assert.ok(body.servers[0].alive);
  });
});

test('broker app MCP message endpoint accepts JSON-RPC and returns 202', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-mcp-msg-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  let receivedBody: unknown = null;
  const runtime = createMcpRuntime(config, record, {
    mcpBroker: {
      async handleMessage(_jobId: string, _serverName: string, body: unknown) {
        receivedBody = body;
      },
    },
  });

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/mcp/test-server/message?token=valid-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { ok: boolean };
    assert.ok(body.ok);
    assert.deepEqual(receivedBody, { jsonrpc: '2.0', method: 'initialize', id: 1 });
  });
});

test('broker app MCP auth accepts rename token when full lease token fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-mcp-rename-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  const runtime = createMcpRuntime(config, record, {
    validate: () => { throw new Error('Invalid lease'); },
  });

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/mcp/status?token=rename-token`);
    assert.equal(response.status, 200);
  });
});

test('broker app MCP auth rejects when both lease and rename tokens fail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-mcp-reject-'));
  const config = createRuntimeConfig(root);
  const record = createRecord(config);
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  const runtime = createMcpRuntime(config, record, {
    validate: () => { throw new Error('Invalid lease'); },
    validateRename: () => { throw new Error('Invalid rename token'); },
  });

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/mcp/status?token=bad-token`);
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /Invalid lease/);
  });
});

test('broker app MCP rejects when agentStateMode is not mounted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-broker-mcp-statemode-'));
  const config = createRuntimeConfig(root);
  const record = {
    ...createRecord(config),
    spec: {
      ...createRecord(config).spec,
      agentStateMode: 'none' as const,
    },
  };
  await mkdir(path.dirname(record.artifacts.securityAuditPath), { recursive: true });

  const runtime = createMcpRuntime(config, record);

  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/broker/jobs/${record.id}/mcp/status?token=valid-token`);
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /agentStateMode/);
  });
});
