import path from 'node:path';
import type { JobRecord } from '../shared/types.js';
import { runCommand } from './process-utils.js';

const DISALLOWED_DOCKER_FLAGS = new Set([
  '--privileged',
  '--pid=host',
  '--network=host',
  '--ipc=host',
  '--device',
  '-v',
  '--volume',
  '--mount',
]);

export class DockerBroker {
  async compose(record: JobRecord, subcommand: 'up' | 'down' | 'ps' | 'logs', args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    validateDockerArgs(record, args);
    return await runCommand('docker', [ 'compose', subcommand, ...args ], { cwd: record.workspacePath });
  }

  async composeExec(record: JobRecord, service: string, command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!service.trim() || command.length === 0) {
      throw new Error('Missing compose exec arguments');
    }
    return await runCommand('docker', [ 'compose', 'exec', service, ...command ], { cwd: record.workspacePath });
  }

  async imageBuild(record: JobRecord, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    validateDockerArgs(record, args);
    return await runCommand('docker', [ 'build', ...args ], { cwd: record.workspacePath });
  }

  async containerRun(record: JobRecord, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    validateDockerArgs(record, args);
    return await runCommand('docker', [ 'run', ...args ], { cwd: record.workspacePath });
  }

  async containerStop(record: JobRecord, containerId: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!containerId.trim()) {
      throw new Error('Missing container id');
    }
    return await runCommand('docker', [ 'stop', containerId ], { cwd: record.workspacePath });
  }

  async wpEnv(record: JobRecord, subcommand: 'start' | 'stop' | 'run' | 'logs', args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await runCommand('npx', [ '@wordpress/env', subcommand, ...args ], { cwd: record.workspacePath });
  }
}

function validateDockerArgs(record: JobRecord, args: string[]): void {
  for (const arg of args) {
    if (DISALLOWED_DOCKER_FLAGS.has(arg)) {
      throw new Error(`Docker flag not allowed: ${arg}`);
    }

    if (arg.includes(':')) {
      const maybePath = arg.split(':', 1)[0];
      if (maybePath.startsWith('/') && !isInsideWorkspace(record.workspacePath, maybePath)) {
        throw new Error(`Docker bind mount escapes workspace: ${arg}`);
      }
    }

    if (arg.startsWith('/')) {
      if (!isInsideWorkspace(record.workspacePath, arg)) {
        throw new Error(`Docker path escapes workspace: ${arg}`);
      }
    }
  }
}

function isInsideWorkspace(workspacePath: string, candidate: string): boolean {
  const relative = path.relative(workspacePath, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
