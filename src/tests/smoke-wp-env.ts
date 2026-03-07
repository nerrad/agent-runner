import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { loadRuntimeConfig } from '../server/config.js';
import { runCommand } from '../server/process-utils.js';

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-wp-env-'));
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'wp-env-smoke', private: true }, null, 2), 'utf8');
  await writeFile(path.join(workspace, '.wp-env.json'), JSON.stringify({
    core: null,
    plugins: [],
    themes: [],
  }, null, 2), 'utf8');

  const result = await runCommand('docker', [
    'run',
    '--rm',
    '--mount',
    `type=bind,src=${config.dockerSocketPath},dst=/var/run/docker.sock`,
    '--mount',
    `type=bind,src=${workspace},dst=/workspace`,
    '--workdir',
    '/workspace',
    'node:22-bookworm-slim',
    'bash',
    '-lc',
    'npm_config_yes=true npx @wordpress/env --version',
  ]);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'wp-env smoke test failed');
  }

  process.stdout.write(`wp-env smoke ok: ${result.stdout.trim()}\n`);
}

void main();
