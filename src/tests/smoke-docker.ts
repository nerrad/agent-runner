import { loadRuntimeConfig } from '../server/config.js';
import { runCommand } from '../server/process-utils.js';

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const result = await runCommand('docker', [ '--host', `unix://${config.dockerSocketPath}`, 'version', '--format', '{{.Server.Version}}' ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'docker smoke test failed');
  }
  process.stdout.write(`docker smoke ok: ${result.stdout.trim()}\n`);
}

void main();

