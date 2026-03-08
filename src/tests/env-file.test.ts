import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { loadProjectEnv, parseEnvFile, readEnvFile, updateEnvFile } from '../server/env-file.js';

test('parseEnvFile handles comments, export prefixes, and quotes', () => {
  const values = parseEnvFile([
    '# comment',
    'export ANTHROPIC_API_KEY="anthropic value"',
    'OPENAI_API_KEY=openai-value # trailing comment',
    'EMPTY=""',
  ].join('\n'));

  assert.deepEqual(values, {
    ANTHROPIC_API_KEY: 'anthropic value',
    OPENAI_API_KEY: 'openai-value',
    EMPTY: '',
  });
});

test('updateEnvFile merges managed values and preserves unrelated entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-env-file-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'CUSTOM_FLAG=true\nANTHROPIC_API_KEY=old-value\n', 'utf8');

  await updateEnvFile(envPath, {
    ANTHROPIC_API_KEY: 'new value',
    OPENAI_API_KEY: 'openai-value',
  });

  const values = await readEnvFile(envPath);
  assert.deepEqual(values, {
    ANTHROPIC_API_KEY: 'new value',
    OPENAI_API_KEY: 'openai-value',
    CUSTOM_FLAG: 'true',
  });
});

test('loadProjectEnv populates missing process env values from .env', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-load-env-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'ANTHROPIC_API_KEY=file-key\nOPENAI_API_KEY=file-openai\n', 'utf8');

  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'existing-openai';

  const loadedPath = await loadProjectEnv(root);

  assert.equal(loadedPath, envPath);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'file-key');
  assert.equal(process.env.OPENAI_API_KEY, 'existing-openai');

  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
