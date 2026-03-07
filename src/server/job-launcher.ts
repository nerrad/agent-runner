import { spawn } from 'node:child_process';
import path from 'node:path';
import type { RuntimeConfig } from './config.js';
import { pathExists } from './fs-utils.js';

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
}

export async function buildInternalRunnerLaunchCommand(config: RuntimeConfig, jobId: string): Promise<LaunchCommand> {
  const builtCliPath = path.join(config.sourceRoot, 'dist', 'server', 'server', 'cli.js');

  if (await pathExists(builtCliPath)) {
    return {
      command: process.execPath,
      args: [ builtCliPath, 'internal-run', jobId ],
      cwd: config.sourceRoot,
    };
  }

  return {
    command: 'pnpm',
    args: [ 'exec', 'tsx', 'src/server/cli.ts', 'internal-run', jobId ],
    cwd: config.sourceRoot,
  };
}

export async function launchDetachedJobRunner(config: RuntimeConfig, jobId: string): Promise<void> {
  const launch = await buildInternalRunnerLaunchCommand(config, jobId);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  child.unref();
}
