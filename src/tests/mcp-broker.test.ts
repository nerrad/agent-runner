import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RuntimeConfig } from '../server/config.js';
import { McpBroker } from '../server/mcp-broker.js';
import { writeJsonAtomic } from '../server/fs-utils.js';
import type { McpServerManifestEntry } from '../server/mcp-rewriter.js';

function createConfig(root: string): RuntimeConfig {
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
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: root,
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
  };
}

async function setupManifest(config: RuntimeConfig, jobId: string, entries: McpServerManifestEntry[]): Promise<void> {
  const artifactDir = path.join(config.artifactsDir, jobId);
  await mkdir(artifactDir, { recursive: true });
  await writeJsonAtomic(path.join(artifactDir, 'mcp-manifest.json'), entries);
}

test('McpBroker.ensureProcess spawns a process from manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-1';

  await setupManifest(config, jobId, [{
    name: 'echo-server',
    source: 'test',
    command: 'cat',
    args: [],
    env: {},
    brokerUrl: 'http://host:4318/broker/jobs/test-job-1/mcp/echo-server/sse',
  }]);

  const state = await broker.ensureProcess(jobId, 'echo-server');
  assert.ok(state.alive);
  assert.ok(state.pid > 0);

  await broker.cleanupJob(jobId);
});

test('McpBroker.ensureProcess throws for unknown server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-unknown-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-2';

  await setupManifest(config, jobId, []);

  await assert.rejects(
    () => broker.ensureProcess(jobId, 'nonexistent'),
    /not found in manifest/,
  );
});

test('McpBroker.ensureProcess reuses existing live process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-reuse-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-3';

  await setupManifest(config, jobId, [{
    name: 'echo-server',
    source: 'test',
    command: 'cat',
    args: [],
    env: {},
    brokerUrl: 'http://host:4318/broker/jobs/test-job-3/mcp/echo-server/sse',
  }]);

  const state1 = await broker.ensureProcess(jobId, 'echo-server');
  const state2 = await broker.ensureProcess(jobId, 'echo-server');
  assert.equal(state1.pid, state2.pid);

  await broker.cleanupJob(jobId);
});

test('McpBroker.getJobStatus returns empty for unknown job', () => {
  const root = '/tmp/mcp-broker-status';
  const config = createConfig(root);
  const broker = new McpBroker(config);

  const status = broker.getJobStatus('nonexistent');
  assert.deepEqual(status, { servers: [] });
});

test('McpBroker.getJobStatus returns process info', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-status-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-4';

  await setupManifest(config, jobId, [{
    name: 'echo-server',
    source: 'test',
    command: 'cat',
    args: [],
    env: {},
    brokerUrl: 'http://host:4318/broker/jobs/test-job-4/mcp/echo-server/sse',
  }]);

  await broker.ensureProcess(jobId, 'echo-server');
  const status = broker.getJobStatus(jobId);

  assert.equal(status.servers.length, 1);
  assert.equal(status.servers[0].name, 'echo-server');
  assert.ok(status.servers[0].alive);
  assert.ok(status.servers[0].pid > 0);

  await broker.cleanupJob(jobId);
});

test('McpBroker.cleanupJob terminates all processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-cleanup-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-5';

  await setupManifest(config, jobId, [{
    name: 'echo-server',
    source: 'test',
    command: 'cat',
    args: [],
    env: {},
    brokerUrl: 'http://host:4318/broker/jobs/test-job-5/mcp/echo-server/sse',
  }]);

  await broker.ensureProcess(jobId, 'echo-server');
  const statusBefore = broker.getJobStatus(jobId);
  assert.equal(statusBefore.servers.length, 1);

  await broker.cleanupJob(jobId);
  const statusAfter = broker.getJobStatus(jobId);
  assert.deepEqual(statusAfter, { servers: [] });
});

test('McpBroker.cleanupJob is idempotent for unknown jobs', async () => {
  const root = '/tmp/mcp-broker-cleanup-noop';
  const config = createConfig(root);
  const broker = new McpBroker(config);

  await broker.cleanupJob('nonexistent');
});

test('McpBroker.handleMessage writes JSON-RPC to stdin', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-msg-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-6';

  // Use `cat` which echoes stdin to stdout — we can verify the message was written
  await setupManifest(config, jobId, [{
    name: 'echo-server',
    source: 'test',
    command: 'cat',
    args: [],
    env: {},
    brokerUrl: 'http://host:4318/broker/jobs/test-job-6/mcp/echo-server/sse',
  }]);

  await broker.ensureProcess(jobId, 'echo-server');

  // Send a message — should not throw
  const message = { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} };
  await broker.handleMessage(jobId, 'echo-server', message);

  await broker.cleanupJob(jobId);
});

test('McpBroker.handleMessage throws for dead process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-msg-dead-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-7';

  await assert.rejects(
    () => broker.handleMessage(jobId, 'nonexistent', {}),
    /not running/,
  );
});

test('McpBroker SSE connection sends endpoint event and forwards stdout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-broker-sse-'));
  const config = createConfig(root);
  const broker = new McpBroker(config);
  const jobId = 'test-job-8';

  // Use `cat` to echo stdin back to stdout
  await setupManifest(config, jobId, [{
    name: 'echo-server',
    source: 'test',
    command: 'cat',
    args: [],
    env: {},
    brokerUrl: 'http://host:4318/broker/jobs/test-job-8/mcp/echo-server/sse',
  }]);

  await broker.ensureProcess(jobId, 'echo-server');

  // Set up a simple express server to test SSE
  const app = express();
  app.get('/sse', (_req, res) => {
    broker.handleSseConnection(jobId, 'echo-server', res, 'http://localhost:9999', 'test-token');
  });

  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/sse`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Read the first chunk which should contain the endpoint event
    const { value } = await reader.read();
    const text = decoder.decode(value);
    assert.match(text, /event: endpoint/);
    assert.match(text, /\/broker\/jobs\/test-job-8\/mcp\/echo-server\/message/);

    reader.cancel();
  } finally {
    await broker.cleanupJob(jobId);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  }
});
