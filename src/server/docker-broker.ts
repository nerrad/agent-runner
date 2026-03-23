import path from 'node:path';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { writeJsonAtomic } from './fs-utils.js';
import { runCommand, type CommandResult } from './process-utils.js';

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

interface ParsedArgs {
  globalArgs: string[];
  values: Array<{ flag: string; value: string }>;
  positionals: string[];
}

interface ParsedComposeArgs {
  globalArgs: string[];
  subcommandArgs: string[];
  values: Array<{ flag: string; value: string }>;
  positionals: string[];
}

const CONTAINER_RUN_FLAGS_WITH_VALUES = new Set([
  '--pull',
  '--env',
  '-e',
  '--env-file',
  '--name',
  '--entrypoint',
  '--workdir',
  '-w',
  '--user',
  '-u',
]);

const CONTAINER_RUN_BOOLEAN_FLAGS = new Set([
  '--rm',
  '-i',
  '-t',
  '-d',
  '--detach',
]);

const BLOCKED_CONTAINER_RUN_FLAGS = new Set([
  '--mount',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '-P',
  '--publish-all',
  '--cap-add',
  '--cap-drop',
  '--device',
  '--network',
  '--pid',
  '--ipc',
  '--userns',
  '--security-opt',
  '--privileged',
  '--cgroupns',
  '--uts',
  '--volumes-from',
  '--add-host',
]);

const COMPOSE_GLOBAL_VALUE_FLAGS = new Set([ '-f', '--file', '--profile', '--env-file' ]);
const COMPOSE_UP_BOOLEAN_FLAGS = new Set([ '--build', '--detach', '-d', '--remove-orphans' ]);
const COMPOSE_DOWN_BOOLEAN_FLAGS = new Set([ '--remove-orphans', '--volumes' ]);
const COMPOSE_PS_BOOLEAN_FLAGS = new Set([ '--all', '--services' ]);
const COMPOSE_LOGS_VALUE_FLAGS = new Set([ '--tail' ]);
const COMPOSE_LOGS_BOOLEAN_FLAGS = new Set([ '--follow' ]);

const BUILD_VALUE_FLAGS = new Set([ '-f', '--file', '--target', '--build-arg', '-t', '--tag' ]);
const BLOCKED_BUILD_FLAGS = new Set([ '--network', '--output', '--secret', '--ssh' ]);

const WP_ENV_START_FLAGS = new Set([ '--xdebug' ]);
const WP_ENV_LOGS_FLAGS = new Set([ '--watch' ]);

export class DockerBroker {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly execute: CommandRunner = runCommand,
  ) {}

  async compose(record: JobRecord, subcommand: 'up' | 'down' | 'ps' | 'logs', args: string[]): Promise<CommandResult> {
    const parsed = parseComposeArgs(subcommand, args);
    await this.validateComposePaths(record, parsed.values);
    if (subcommand === 'up') {
      await this.validateComposeConfig(record, parsed.globalArgs);
    }

    const result = await this.execute('docker', [
      'compose',
      '-p',
      this.projectName(record),
      ...parsed.globalArgs,
      subcommand,
      ...parsed.subcommandArgs,
      ...parsed.positionals,
    ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    });

    if (subcommand === 'up' || subcommand === 'down') {
      const state = await this.refreshState(record);
      if (subcommand === 'up') {
        try {
          await this.enforceTrackedContainersSafe(record, state);
        } catch (error) {
          await this.cleanupJob(record).catch(() => undefined);
          throw error;
        }
      } else {
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
    const parsed = parseBuildArgs(args);
    for (const entry of parsed.values) {
      if (entry.flag === '-f' || entry.flag === '--file') {
        resolveWorkspacePath(record, entry.value);
      }
    }
    if (parsed.positionals.length !== 1) {
      throw new Error('docker build requires exactly one build context');
    }
    resolveWorkspacePath(record, parsed.positionals[0]);

    return await this.execute(
      'docker',
      [ 'build', '--label', `agent-runner.job=${record.id}`, '--label', `agent-runner.profile=${record.spec.capabilityProfile}`, ...parsed.globalArgs, parsed.positionals[0] ],
      { cwd: record.workspacePath },
    );
  }

  async containerRun(record: JobRecord, args: string[]): Promise<CommandResult> {
    const parsed = parseContainerRunArgs(record, args);
    const result = await this.execute('docker', [
      'run',
      '--label',
      `agent-runner.job=${record.id}`,
      '--label',
      `agent-runner.profile=${record.spec.capabilityProfile}`,
      '--label',
      `agent-runner.project=${this.projectName(record)}`,
      ...parsed.globalArgs,
      ...parsed.positionals,
    ], {
      cwd: record.workspacePath,
    });
    const state = await this.refreshState(record);
    try {
      await this.enforceTrackedContainersSafe(record, state);
    } catch (error) {
      await this.cleanupJob(record).catch(() => undefined);
      throw error;
    }
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
    validateWpEnvArgs(subcommand, args);
    const result = await this.execute('npx', [ '@wordpress/env', subcommand, ...args ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    });

    if (subcommand === 'start' || subcommand === 'stop') {
      const state = await this.refreshState(record);
      if (subcommand === 'start') {
        try {
          await this.enforceTrackedContainersSafe(record, state);
        } catch (error) {
          await this.cleanupJob(record).catch(() => undefined);
          throw error;
        }
      } else {
        await this.cleanupTrackedState(record);
      }
    }

    return result;
  }

  async cleanupJob(record: JobRecord): Promise<void> {
    const state = await this.readState(record.id);
    const projectName = state?.projectName ?? this.projectName(record);

    const composeDown = await this.execute('docker', [ 'compose', '-p', projectName, 'down', '--volumes', '--remove-orphans' ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    }).catch((error) => {
      console.warn(`[docker-broker] compose down failed for job ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    if (composeDown.exitCode !== 0) {
      console.warn(`[docker-broker] compose down exited ${composeDown.exitCode} for job ${record.id}`);
    }

    const currentState = await this.refreshState(record).catch(() => state ?? this.emptyState(record.id, projectName));

    for (const containerId of currentState.containers) {
      await this.removeWithRetry('rm', ['-f', containerId], record.id, `container ${containerId}`, record.workspacePath);
    }

    for (const networkId of currentState.networks) {
      await this.removeWithRetry('network', ['rm', networkId], record.id, `network ${networkId}`, record.workspacePath);
    }

    for (const volumeName of currentState.volumes) {
      await this.removeWithRetry('volume', ['rm', '-f', volumeName], record.id, `volume ${volumeName}`, record.workspacePath);
    }

    await writeJsonAtomic(this.statePath(record.id), this.emptyState(record.id, projectName));
  }

  private async removeWithRetry(
    subcommand: string,
    args: string[],
    jobId: string,
    description: string,
    cwd: string,
  ): Promise<void> {
    const attempt = async () => {
      const result = await this.execute('docker', [subcommand, ...args], { cwd })
        .catch((error) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
      return result;
    };

    let result = await attempt();
    if (result.exitCode === 0) return;

    // Single retry
    result = await attempt();
    if (result.exitCode !== 0) {
      console.warn(`[docker-broker] failed to remove ${description} for job ${jobId} after retry: ${result.stderr}`);
    }
  }

  async getTrackedState(jobId: string): Promise<DockerResourceState | null> {
    return await this.readState(jobId);
  }

  /**
   * Remove containers, networks, and volumes that belong to agent-runner jobs
   * which are no longer active.  Called once at startup before any new jobs run.
   */
  async cleanupOrphanedResources(activeJobIds: Set<string>): Promise<{ containers: number; networks: number; volumes: number }> {
    const removed = { containers: 0, networks: 0, volumes: 0 };

    // Find all containers labelled as agent-runner resources
    const containerResult = await this.execute('docker', [
      'ps', '-a',
      '--filter', 'label=agent-runner.job',
      '--format', '{{.ID}}\t{{.Label "agent-runner.job"}}',
    ]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));

    if (containerResult.exitCode !== 0) {
      return removed;
    }

    const orphanJobIds = new Set<string>();
    for (const line of containerResult.stdout.split('\n').filter(Boolean)) {
      const [containerId, jobId] = line.split('\t');
      if (!containerId || !jobId) continue;
      if (activeJobIds.has(jobId)) continue;

      orphanJobIds.add(jobId);
      const rmResult = await this.execute('docker', ['rm', '-f', containerId]).catch(() => ({ exitCode: 1, stdout: '', stderr: 'unknown' }));
      if (rmResult.exitCode === 0) {
        removed.containers += 1;
      } else {
        console.warn(`[docker-broker] failed to remove orphan container ${containerId} (job ${jobId}): ${rmResult.stderr}`);
      }
    }

    // Clean up compose networks/volumes for orphaned project names
    for (const jobId of orphanJobIds) {
      const projectName = `agent-runner-${jobId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).toLowerCase()}`;

      const networkResult = await this.execute('docker', [
        'network', 'ls',
        '--filter', `label=com.docker.compose.project=${projectName}`,
        '--format', '{{.ID}}',
      ]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));

      if (networkResult.exitCode === 0) {
        for (const networkId of networkResult.stdout.split('\n').filter(Boolean)) {
          const rmResult = await this.execute('docker', ['network', 'rm', networkId]).catch(() => ({ exitCode: 1, stdout: '', stderr: 'unknown' }));
          if (rmResult.exitCode === 0) {
            removed.networks += 1;
          } else {
            console.warn(`[docker-broker] failed to remove orphan network ${networkId} (project ${projectName}): ${rmResult.stderr}`);
          }
        }
      }

      const volumeResult = await this.execute('docker', [
        'volume', 'ls',
        '--filter', `label=com.docker.compose.project=${projectName}`,
        '--format', '{{.Name}}',
      ]).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));

      if (volumeResult.exitCode === 0) {
        for (const volumeName of volumeResult.stdout.split('\n').filter(Boolean)) {
          const rmResult = await this.execute('docker', ['volume', 'rm', '-f', volumeName]).catch(() => ({ exitCode: 1, stdout: '', stderr: 'unknown' }));
          if (rmResult.exitCode === 0) {
            removed.volumes += 1;
          } else {
            console.warn(`[docker-broker] failed to remove orphan volume ${volumeName} (project ${projectName}): ${rmResult.stderr}`);
          }
        }
      }
    }

    return removed;
  }

  private async validateComposeConfig(record: JobRecord, globalArgs: string[]): Promise<void> {
    const result = await this.execute('docker', [
      'compose',
      '-p',
      this.projectName(record),
      ...globalArgs,
      'config',
      '--format',
      'json',
    ], {
      cwd: record.workspacePath,
      env: this.composeEnv(record),
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to render docker compose config');
    }

    const parsed = JSON.parse(result.stdout) as {
      services?: Record<string, Record<string, unknown>>;
    };
    const services = parsed.services ?? {};
    for (const [ serviceName, service ] of Object.entries(services)) {
      assertComposeServiceSafe(record, serviceName, service);
    }
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

  private async enforceTrackedContainersSafe(record: JobRecord, state: DockerResourceState): Promise<void> {
    for (const containerId of state.containers) {
      const inspect = await this.execute('docker', [ 'inspect', containerId ], { cwd: record.workspacePath });
      if (inspect.exitCode !== 0) {
        throw new Error(`Failed to inspect brokered container ${containerId}`);
      }
      const [ details ] = JSON.parse(inspect.stdout) as Array<Record<string, unknown>>;
      assertInspectedContainerSafe(record, containerId, details);
    }
  }

  private async cleanupTrackedState(record: JobRecord): Promise<void> {
    await writeJsonAtomic(this.statePath(record.id), this.emptyState(record.id, this.projectName(record)));
  }

  private async validateComposePaths(record: JobRecord, values: Array<{ flag: string; value: string }>): Promise<void> {
    for (const entry of values) {
      if (entry.flag === '-f' || entry.flag === '--file' || entry.flag === '--env-file') {
        resolveWorkspacePath(record, entry.value);
      }
    }
  }

  private async listResources(
    command: 'ps' | 'network' | 'volume',
    args: string[],
    cwd: string,
  ): Promise<string[]> {
    const result = await this.execute('docker', [ command, ...args ], { cwd });
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

function parseContainerRunArgs(record: JobRecord, args: string[]): ParsedArgs {
  const parsed = parseArgs(args, {
    valueFlags: CONTAINER_RUN_FLAGS_WITH_VALUES,
    booleanFlags: CONTAINER_RUN_BOOLEAN_FLAGS,
    blockedFlags: BLOCKED_CONTAINER_RUN_FLAGS,
  });

  for (const entry of parsed.values) {
    if (entry.flag === '--env-file') {
      resolveWorkspacePath(record, entry.value);
    }
  }

  if (parsed.positionals.length === 0) {
    throw new Error('docker run requires an image');
  }

  return parsed;
}

function parseBuildArgs(args: string[]): ParsedArgs {
  return parseArgs(args, {
    valueFlags: BUILD_VALUE_FLAGS,
    booleanFlags: new Set<string>(),
    blockedFlags: BLOCKED_BUILD_FLAGS,
  });
}

function parseComposeArgs(
  subcommand: 'up' | 'down' | 'ps' | 'logs',
  args: string[],
): ParsedComposeArgs {
  const globalArgs: string[] = [];
  const subcommandArgs: string[] = [];
  const values: Array<{ flag: string; value: string }> = [];
  const positionals: string[] = [];

  const subcommandValueFlags = subcommand === 'logs'
    ? COMPOSE_LOGS_VALUE_FLAGS
    : new Set<string>();
  const subcommandBooleanFlags = subcommand === 'up'
    ? COMPOSE_UP_BOOLEAN_FLAGS
    : subcommand === 'down'
      ? COMPOSE_DOWN_BOOLEAN_FLAGS
      : subcommand === 'ps'
        ? COMPOSE_PS_BOOLEAN_FLAGS
        : COMPOSE_LOGS_BOOLEAN_FLAGS;

  let positionalMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (positionalMode || arg === '--') {
      if (arg === '--') {
        positionalMode = true;
        continue;
      }
      positionals.push(arg);
      continue;
    }

    if (!arg.startsWith('-')) {
      positionalMode = true;
      positionals.push(arg);
      continue;
    }

    const [ flag, inlineValue ] = arg.split('=', 2);
    if (flag === '-p' || flag === '--project-name') {
      throw new Error(`Blocked Docker option: ${flag}`);
    }

    if (COMPOSE_GLOBAL_VALUE_FLAGS.has(flag)) {
      const value = inlineValue ?? args[index + 1];
      if (!value || (!inlineValue && value.startsWith('-'))) {
        throw new Error(`Missing value for ${flag}`);
      }
      globalArgs.push(flag, value);
      values.push({ flag, value });
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (subcommandValueFlags.has(flag)) {
      const value = inlineValue ?? args[index + 1];
      if (!value || (!inlineValue && value.startsWith('-'))) {
        throw new Error(`Missing value for ${flag}`);
      }
      subcommandArgs.push(flag, value);
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (subcommandBooleanFlags.has(flag)) {
      subcommandArgs.push(flag);
      continue;
    }

    throw new Error(`Unsupported Docker option: ${flag}`);
  }

  return { globalArgs, subcommandArgs, values, positionals };
}

function parseArgs(
  args: string[],
  config: {
    valueFlags: Set<string>;
    booleanFlags: Set<string>;
    blockedFlags: Set<string>;
  },
): ParsedArgs {
  const globalArgs: string[] = [];
  const values: Array<{ flag: string; value: string }> = [];
  const positionals: string[] = [];
  let positionalMode = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (positionalMode || arg === '--') {
      if (arg === '--') {
        positionalMode = true;
        continue;
      }
      positionals.push(arg);
      continue;
    }

    if (!arg.startsWith('-')) {
      positionalMode = true;
      positionals.push(arg);
      continue;
    }

    const [ flag, inlineValue ] = arg.split('=', 2);
    if (config.blockedFlags.has(flag)) {
      throw new Error(`Blocked Docker option: ${flag}`);
    }

    if (config.valueFlags.has(flag)) {
      const value = inlineValue ?? args[index + 1];
      if (!value || (!inlineValue && value.startsWith('-'))) {
        throw new Error(`Missing value for ${flag}`);
      }
      globalArgs.push(flag, value);
      values.push({ flag, value });
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (config.booleanFlags.has(flag)) {
      globalArgs.push(flag);
      continue;
    }

    if (flag.startsWith('--') || flag.startsWith('-')) {
      throw new Error(`Unsupported Docker option: ${flag}`);
    }
  }

  return { globalArgs, values, positionals };
}

function resolveWorkspacePath(record: JobRecord, candidate: string): string {
  const workspaceRoot = canonicalizePath(record.workspacePath);
  const resolved = canonicalizePath(path.resolve(workspaceRoot, candidate));
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${candidate}`);
  }
  return resolved;
}

function canonicalizePath(targetPath: string): string {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function validateWpEnvArgs(subcommand: 'start' | 'stop' | 'run' | 'logs', args: string[]): void {
  if (subcommand === 'stop') {
    if (args.length > 0) {
      throw new Error('wp-env stop does not accept extra arguments');
    }
    return;
  }

  if (subcommand === 'start') {
    for (const arg of args) {
      if (!WP_ENV_START_FLAGS.has(arg)) {
        throw new Error(`Unsupported wp-env start argument: ${arg}`);
      }
    }
    return;
  }

  if (subcommand === 'logs') {
    for (const arg of args) {
      if (arg.startsWith('-') && !WP_ENV_LOGS_FLAGS.has(arg)) {
        throw new Error(`Unsupported wp-env logs argument: ${arg}`);
      }
    }
    return;
  }

  if (args.length < 2) {
    throw new Error('wp-env run requires a service and command');
  }

  if (args.some((arg, index) => index > 0 && arg.startsWith('-'))) {
    throw new Error('Unsupported wp-env run option');
  }
}

function assertComposeServiceSafe(record: JobRecord, serviceName: string, service: Record<string, unknown>): void {
  for (const blockedKey of [ 'privileged', 'cap_add', 'devices', 'volumes_from', 'security_opt' ]) {
    const value = service[blockedKey];
    if ((Array.isArray(value) && value.length > 0) || value === true || (typeof value === 'string' && value.length > 0)) {
      throw new Error(`Compose service ${serviceName} uses blocked setting ${blockedKey}`);
    }
  }

  for (const blockedMode of [ 'network_mode', 'pid', 'ipc', 'userns_mode' ]) {
    if (service[blockedMode] === 'host') {
      throw new Error(`Compose service ${serviceName} uses blocked setting ${blockedMode}=host`);
    }
  }

  const volumes = Array.isArray(service.volumes) ? service.volumes : [];
  for (const volume of volumes) {
    if (typeof volume === 'string') {
      const [ source ] = volume.split(':');
      if (source && (source.startsWith('.') || source.startsWith('/') || source.includes('..'))) {
        resolveWorkspacePath(record, source);
      }
      continue;
    }

    if (!volume || typeof volume !== 'object') {
      continue;
    }

    const typed = volume as Record<string, unknown>;
    if ((typed.type ?? 'volume') === 'bind') {
      const source = typeof typed.source === 'string' ? typed.source : typeof typed.src === 'string' ? typed.src : '';
      if (source) {
        resolveWorkspacePath(record, source);
      }
    }
  }
}

function assertInspectedContainerSafe(record: JobRecord, containerId: string, details: Record<string, unknown>): void {
  const hostConfig = (details.HostConfig && typeof details.HostConfig === 'object') ? details.HostConfig as Record<string, unknown> : {};
  if (hostConfig.Privileged === true) {
    throw new Error(`Brokered container ${containerId} is privileged`);
  }
  if (hostConfig.NetworkMode === 'host' || hostConfig.PidMode === 'host' || hostConfig.IpcMode === 'host' || hostConfig.UsernsMode === 'host') {
    throw new Error(`Brokered container ${containerId} uses blocked host namespace settings`);
  }
  if (Array.isArray(hostConfig.CapAdd) && hostConfig.CapAdd.length > 0) {
    throw new Error(`Brokered container ${containerId} adds capabilities`);
  }
  if (Array.isArray(hostConfig.Devices) && hostConfig.Devices.length > 0) {
    throw new Error(`Brokered container ${containerId} mounts devices`);
  }
  if (Array.isArray(hostConfig.SecurityOpt) && hostConfig.SecurityOpt.length > 0) {
    throw new Error(`Brokered container ${containerId} uses security-opt`);
  }

  const mounts = Array.isArray(details.Mounts) ? details.Mounts as Array<Record<string, unknown>> : [];
  for (const mount of mounts) {
    const source = typeof mount.Source === 'string' ? mount.Source : '';
    const type = typeof mount.Type === 'string' ? mount.Type : '';
    if (type === 'bind' && source) {
      resolveWorkspacePath(record, source);
    }
  }
}
