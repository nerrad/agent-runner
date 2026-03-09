import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig } from './config.js';
import { pathExists } from './fs-utils.js';

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
}

export async function buildInternalRunnerLaunchCommand(config: RuntimeConfig, jobId: string): Promise<LaunchCommand> {
  const sourceCliPath = path.join(config.sourceRoot, 'src', 'server', 'cli.ts');
  const builtCliPath = path.join(config.sourceRoot, 'dist', 'server', 'server', 'cli.js');

  if (await pathExists(sourceCliPath)) {
    return {
      command: process.execPath,
      args: [ '--import', 'tsx', sourceCliPath, 'internal-run', jobId ],
      cwd: config.sourceRoot,
    };
  }

  if (await pathExists(builtCliPath)) {
    return {
      command: process.execPath,
      args: [ builtCliPath, 'internal-run', jobId ],
      cwd: config.sourceRoot,
    };
  }

  return {
    command: process.execPath,
    args: [ '--import', 'tsx', sourceCliPath, 'internal-run', jobId ],
    cwd: config.sourceRoot,
  };
}

export async function launchDetachedJobRunner(config: RuntimeConfig, jobId: string): Promise<void> {
  const launch = await buildInternalRunnerLaunchCommand(config, jobId);
  const launcherLogPath = path.join(config.artifactsDir, jobId, 'launcher.log');
  mkdirSync(path.dirname(launcherLogPath), { recursive: true });
  const launcherLogFd = openSync(launcherLogPath, 'a');
  try {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      stdio: [ 'ignore', launcherLogFd, launcherLogFd ],
      env: process.env,
    });
    closeSync(launcherLogFd);

    child.unref();
  } catch (error) {
    closeSync(launcherLogFd);
    throw error;
  }
}
