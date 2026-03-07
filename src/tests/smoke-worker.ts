import { loadRuntimeConfig } from '../server/config.js';
import { runCommand } from '../server/process-utils.js';

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const dockerfilePath = new URL('../../docker/worker.Dockerfile', import.meta.url).pathname;
  const imageTag = `${config.workerImageTag}-smoke`;

  const build = await runCommand('docker', [
    'build',
    '-t',
    imageTag,
    '-f',
    dockerfilePath,
    config.sourceRoot,
  ]);

  if (build.exitCode !== 0) {
    throw new Error(build.stderr || 'worker image build failed');
  }

  const check = await runCommand('docker', [
    'run',
    '--rm',
    imageTag,
    'bash',
    '-lc',
    'node --version && npm --version && pnpm --version && python --version && python3 --version && php --version && composer --version',
  ]);

  if (check.exitCode !== 0) {
    throw new Error(check.stderr || 'worker toolchain smoke test failed');
  }

  process.stdout.write(check.stdout);
}

void main();
