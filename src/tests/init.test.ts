import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { RuntimeConfig } from '../server/config.js';
import { readEnvFile } from '../server/env-file.js';
import { runInit } from '../server/init.js';

function createRuntimeConfig(root: string): RuntimeConfig {
  return {
    appDir: path.join(root, '.agent-runner'),
    jobsDir: path.join(root, '.agent-runner', 'jobs'),
    workspacesDir: path.join(root, '.agent-runner', 'workspaces'),
    artifactsDir: path.join(root, '.agent-runner', 'artifacts'),
    specRoot: path.join(root, '.agent-runner', 'specs'),
    ghConfigDir: path.join(root, '.config', 'gh'),
    claudeDir: path.join(root, '.claude'),
    claudeSettingsPath: path.join(root, '.claude.json'),
    codexDir: path.join(root, '.codex'),
    dockerSocketPath: '/tmp/docker.sock',
    githubProxyUrl: undefined,
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: root,
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
  };
}

test('runInit writes prompted keys into source-root .env', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-init-'));
  const config = createRuntimeConfig(root);
  const answers = [ 'anthropic-test-key', 'openai-test-key' ];

  const result = await runInit(config, async () => answers.shift() ?? '');
  const values = await readEnvFile(path.join(root, '.env'));

  assert.equal(result.envPath, path.join(root, '.env'));
  assert.deepEqual(result.savedKeys, [ 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY' ]);
  assert.equal(values.ANTHROPIC_API_KEY, 'anthropic-test-key');
  assert.equal(values.OPENAI_API_KEY, 'openai-test-key');
});

test('runInit preserves existing values on blank input and clears on dash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-init-preserve-'));
  const config = createRuntimeConfig(root);
  await writeFile(path.join(root, '.env'), 'ANTHROPIC_API_KEY=keep-me\nOPENAI_API_KEY=remove-me\n', 'utf8');
  const answers = [ '', '-' ];

  const result = await runInit(config, async () => answers.shift() ?? '');
  const values = await readEnvFile(path.join(root, '.env'));

  assert.deepEqual(result.savedKeys, [ 'ANTHROPIC_API_KEY' ]);
  assert.equal(values.ANTHROPIC_API_KEY, 'keep-me');
  assert.equal(values.OPENAI_API_KEY, undefined);
});
