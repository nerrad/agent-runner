import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { writeJsonAtomic } from './fs-utils.js';
import { runCommand, type CommandResult } from './process-utils.js';

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

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

interface DockerResourceState {
  jobId: string;
  projectName: string;
  containers: string[];
  networks: string[];
  volumes: string[];
}

export class DockerBroker {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly execute: CommandRunner = runCommand,
  ) {}

  async compose(record: JobRecord, subcommand: 'up' | 'down' | 'ps' | 'logs', args: string[]): Promise<CommandResult> {
    validateDockerArgs(record, args);
    const result = await this.execute('docker', [ 'compose', '-p', this.projectName(record), subcommand, ...args ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    });

    if (subcommand === 'up' || subcommand === 'down') {
      await this.refreshState(record);
      if (subcommand === 'down') {
        await this.cleanupTrackedState(record);
      }
    }

    return result;
  }

  async composeExec(record: JobRecord, service: string, command: string[]): Promise<CommandResult> {
    if (!service.trim() || command.length === 0) {
      throw new Error('Missing compose exec arguments');
    }
    await this.ensureComposeServiceOwned(record, service);
    return await this.execute('docker', [ 'compose', '-p', this.projectName(record), 'exec', service, ...command ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    });
  }

  async imageBuild(record: JobRecord, args: string[]): Promise<CommandResult> {
    validateDockerArgs(record, args);
    return await this.execute('docker', [ 'build', '--label', `agent-runner.job=${record.id}`, '--label', `agent-runner.profile=${record.spec.capabilityProfile}`, ...args ], {
      cwd: record.workspacePath,
    });
  }

  async containerRun(record: JobRecord, args: string[]): Promise<CommandResult> {
    validateDockerArgs(record, args);
    const result = await this.execute('docker', [
      'run',
      '--label',
      `agent-runner.job=${record.id}`,
      '--label',
      `agent-runner.profile=${record.spec.capabilityProfile}`,
      '--label',
      `agent-runner.project=${this.projectName(record)}`,
      ...args,
    ], {
      cwd: record.workspacePath,
    });
    await this.refreshState(record);
    return result;
  }

  async containerStop(record: JobRecord, containerId: string): Promise<CommandResult> {
    if (!containerId.trim()) {
      throw new Error('Missing container id');
    }
    await this.ensureContainerOwned(record, containerId);
    const result = await this.execute('docker', [ 'stop', containerId ], { cwd: record.workspacePath });
    await this.refreshState(record);
    return result;
  }

  async wpEnv(record: JobRecord, subcommand: 'start' | 'stop' | 'run' | 'logs', args: string[]): Promise<CommandResult> {
    const result = await this.execute('npx', [ '@wordpress/env', subcommand, ...args ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    });

    if (subcommand === 'start' || subcommand === 'stop') {
      await this.refreshState(record);
      if (subcommand === 'stop') {
        await this.cleanupTrackedState(record);
      }
    }

    return result;
  }

  async cleanupJob(record: JobRecord): Promise<void> {
    const state = await this.readState(record.id);
    const projectName = state?.projectName ?? this.projectName(record);

    await this.execute('docker', [ 'compose', '-p', projectName, 'down', '--volumes', '--remove-orphans' ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    }).catch(() => undefined);

    const currentState = await this.refreshState(record).catch(() => state ?? this.emptyState(record.id, projectName));

    for (const containerId of currentState.containers) {
      await this.execute('docker', [ 'rm', '-f', containerId ], { cwd: record.workspacePath }).catch(() => undefined);
    }

    for (const networkId of currentState.networks) {
      await this.execute('docker', [ 'network', 'rm', networkId ], { cwd: record.workspacePath }).catch(() => undefined);
    }

    for (const volumeName of currentState.volumes) {
      await this.execute('docker', [ 'volume', 'rm', '-f', volumeName ], { cwd: record.workspacePath }).catch(() => undefined);
    }

    await writeJsonAtomic(this.statePath(record.id), this.emptyState(record.id, projectName));
  }

  async getTrackedState(jobId: string): Promise<DockerResourceState | null> {
    return await this.readState(jobId);
  }

  private async ensureContainerOwned(record: JobRecord, containerId: string): Promise<void> {
    const inspect = await this.execute('docker', [
      'inspect',
      '--format',
      '{{ index .Config.Labels "agent-runner.job" }}',
      containerId,
    ], { cwd: record.workspacePath });

    if (inspect.exitCode !== 0 || inspect.stdout.trim() !== record.id) {
      throw new Error(`Container ${containerId} is not owned by job ${record.id}`);
    }
  }

  private async ensureComposeServiceOwned(record: JobRecord, service: string): Promise<void> {
    const result = await this.execute('docker', [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${this.projectName(record)}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.ID}}',
    ], { cwd: record.workspacePath });

    if (result.exitCode !== 0 || result.stdout.trim() === '') {
      throw new Error(`Compose service ${service} is not owned by job ${record.id}`);
    }
  }

  private async refreshState(record: JobRecord): Promise<DockerResourceState> {
    const projectName = this.projectName(record);
    const [ containers, networks, volumes ] = await Promise.all([
      this.listResources('ps', [
        '-a',
        '--filter',
        `label=agent-runner.job=${record.id}`,
        '--format',
        '{{.ID}}',
      ], record.workspacePath),
      this.listResources('network', [
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.ID}}',
      ], record.workspacePath),
      this.listResources('volume', [
        'ls',
        '--filter',
        `label=com.docker.compose.project=${projectName}`,
        '--format',
        '{{.Name}}',
      ], record.workspacePath),
    ]);

    const state: DockerResourceState = {
      jobId: record.id,
      projectName,
      containers,
      networks,
      volumes,
    };
    await writeJsonAtomic(this.statePath(record.id), state);
    return state;
  }

  private async cleanupTrackedState(record: JobRecord): Promise<void> {
    await writeJsonAtomic(this.statePath(record.id), this.emptyState(record.id, this.projectName(record)));
  }

  private async listResources(
    command: 'ps' | 'network' | 'volume',
    args: string[],
    cwd: string,
  ): Promise<string[]> {
    const result = await this.execute('docker', command === 'ps' ? [ command, ...args ] : [ command, ...args ], { cwd });
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private composeEnv(record: JobRecord): NodeJS.ProcessEnv {
    return {
      ...process.env,
      COMPOSE_PROJECT_NAME: this.projectName(record),
      WP_ENV_HOME: path.join(this.config.appDir, 'wp-env', record.id),
    };
  }

  private projectName(record: JobRecord): string {
    return `agent-runner-${record.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).toLowerCase()}`;
  }

  private statePath(jobId: string): string {
    return path.join(this.config.jobsDir, jobId, 'docker-resources.json');
  }

  private emptyState(jobId: string, projectName: string): DockerResourceState {
    return {
      jobId,
      projectName,
      containers: [],
      networks: [],
      volumes: [],
    };
  }

  private async readState(jobId: string): Promise<DockerResourceState | null> {
    try {
      const raw = await readFile(this.statePath(jobId), 'utf8');
      return JSON.parse(raw) as DockerResourceState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
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
