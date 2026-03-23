import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord } from '../shared/types.js';
import { CONTAINER_HOME, type RuntimeConfig } from './config.js';
import type { McpRewriteFileOverlay } from './mcp-rewriter.js';
import { runCommand } from './process-utils.js';

export interface DockerRunRequest {
  job: JobRecord;
  command: string[];
  env: Record<string, string>;
  onLog: (chunk: string) => Promise<void> | void;
  onStart?: (containerId: string) => Promise<void> | void;
  mcpOverlays?: McpRewriteFileOverlay[];
}

export class DockerRunner {
  constructor(private readonly config: RuntimeConfig) {}

  async ensureImageBuilt(): Promise<void> {
    const dockerfilePath = path.join(this.config.sourceRoot, 'docker', 'worker.Dockerfile');
    const result = await runCommand('docker', [
      'build',
      '-t',
      this.config.workerImageTag,
      '-f',
      dockerfilePath,
      this.config.sourceRoot,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to build worker image');
    }
  }

  async runJob(request: DockerRunRequest): Promise<{ containerId: string; exitCode: number }> {
    const dockerArgs = await this.buildRunArgs(request);
    const runResult = await runCommand('docker', dockerArgs);
    if (runResult.exitCode !== 0) {
      throw new Error(runResult.stderr || 'Failed to start worker container');
    }

    const containerId = runResult.stdout.trim();
    await request.onStart?.(containerId);

    const logPromise = runCommand('docker', [ 'logs', '--follow', containerId ], {
      onStdout: (chunk) => void request.onLog(chunk),
      onStderr: (chunk) => void request.onLog(chunk),
    });

    const waitResult = await runCommand('docker', [ 'wait', containerId ]);
    const logResult = await logPromise;
    if (logResult.exitCode !== 0) {
      await request.onLog(logResult.stderr);
    }

    const exitCode = Number.parseInt(waitResult.stdout.trim(), 10);
    return { containerId, exitCode: Number.isNaN(exitCode) ? 1 : exitCode };
  }

  async buildRunArgs(request: DockerRunRequest): Promise<string[]> {
    const containerName = `agent-runner-${request.job.id}`;
    const sshMountTarget = '/tmp/agent-runner-ssh.sock';
    const ghMountTarget = '/gh-config';
    const containerHome = CONTAINER_HOME;
    const { capabilityProfile, agentStateMode } = request.job.spec;
    const env = await this.resolveContainerEnv(request);

    const dockerArgs = [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--workdir',
      '/workspace',
      '--user',
      `${this.config.hostUid ?? 1000}:${this.config.hostGid ?? 1000}`,
      // OrbStack exposes the mounted Docker socket as root:root inside the worker.
      '--group-add',
      '0',
      '--mount',
      `type=bind,src=${request.job.workspacePath},dst=/workspace`,
      '--mount',
      `type=bind,src=${request.job.artifacts.specBundlePath},dst=/spec,readonly`,
      '--mount',
      `type=bind,src=${request.job.artifacts.inputsDir},dst=/inputs,readonly`,
      '--mount',
      `type=bind,src=${request.job.artifacts.outputsDir},dst=/outputs`,
      '--env',
      `HOME=${containerHome}`,
      '--env',
      'USER=agent-runner',
      '--env',
      'LOGNAME=agent-runner',
      '--env',
      `AGENT_RUNNER_PROFILE=${capabilityProfile}`,
    ];

    if (this.config.dockerMemoryLimit) {
      dockerArgs.push('--memory', this.config.dockerMemoryLimit);
    }
    if (this.config.dockerCpuLimit) {
      dockerArgs.push('--cpus', this.config.dockerCpuLimit);
    }

    if (capabilityProfile !== 'dangerous') {
      dockerArgs.push('--cap-drop=ALL');
      dockerArgs.push('--security-opt=no-new-privileges');
    }

    if (capabilityProfile === 'dangerous') {
      // OrbStack exposes the mounted Docker socket as root:root inside the worker.
      dockerArgs.push('--group-add', '0');
      dockerArgs.push('--mount', `type=bind,src=${path.dirname(request.job.artifacts.logPath)},dst=/artifacts`);
      dockerArgs.push('--mount', `type=bind,src=${this.config.dockerSocketPath},dst=/var/run/docker.sock`);
      dockerArgs.push('--env', `DOCKER_HOST=unix:///var/run/docker.sock`);
      dockerArgs.push('--mount', `type=bind,src=${this.config.ghConfigDir},dst=${ghMountTarget},readonly`);
      dockerArgs.push('--env', `GH_CONFIG_DIR=${ghMountTarget}`);
    }

    if (agentStateMode === 'mounted') {
      dockerArgs.push('--mount', `type=bind,src=${this.config.claudeDir},dst=${containerHome}/.claude`);
      dockerArgs.push('--mount', `type=bind,src=${this.config.claudeSettingsPath},dst=${containerHome}/.claude.json`);
      dockerArgs.push('--mount', `type=bind,src=${this.config.codexDir},dst=${containerHome}/.codex`);
    }

    if (request.mcpOverlays) {
      for (const overlay of request.mcpOverlays) {
        dockerArgs.push('--mount', `type=bind,src=${overlay.hostStagingPath},dst=${overlay.containerTargetPath},readonly`);
      }
    }

    if (capabilityProfile === 'dangerous' && this.config.sshAuthSock) {
      dockerArgs.push('--mount', `type=bind,src=${this.config.sshAuthSock},dst=${sshMountTarget}`);
      dockerArgs.push('--env', `SSH_AUTH_SOCK=${sshMountTarget}`);
    }

    for (const [ key, value ] of Object.entries(env)) {
      dockerArgs.push('--env', `${key}=${value}`);
    }

    dockerArgs.push(this.config.workerImageTag, ...request.command);
    return dockerArgs;
  }

  private async resolveContainerEnv(request: DockerRunRequest): Promise<Record<string, string>> {
    const env = { ...request.env };
    const { capabilityProfile } = request.job.spec;

    env.AGENT_RUNNER_JOB_ID ??= request.job.id;
    env.AGENT_RUNNER_BROKER_URL ??= this.config.brokerUrl;

    if (!env.AGENT_RUNNER_BROKER_TOKEN) {
      try {
        const leasePath = path.join(this.config.jobsDir, request.job.id, 'broker-lease.json');
        const raw = await readFile(leasePath, 'utf8');
        const lease = JSON.parse(raw) as { token?: string; renameToken?: string };
        const isBrokerProfile = capabilityProfile === 'repo-broker' || capabilityProfile === 'docker-broker';
        const tokenValue = isBrokerProfile ? lease.token : lease.renameToken;
        if (tokenValue) {
          env.AGENT_RUNNER_BROKER_TOKEN = tokenValue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    return env;
  }

  async stopJob(containerId: string): Promise<void> {
    await runCommand('docker', [ 'stop', containerId ]);
  }

  createDebugCommand(record: JobRecord): string {
    return `docker exec -it ${record.containerId ?? `agent-runner-${record.id}`} bash`;
  }

  async appendTranscript(artifactPath: string, chunk: string): Promise<void> {
    await appendFile(artifactPath, chunk, 'utf8');
  }

  async writeLog(artifactPath: string, content: string): Promise<void> {
    await writeFile(artifactPath, content, 'utf8');
  }

  async readFinalResponse(artifactPath: string): Promise<string> {
    return await readFile(artifactPath, 'utf8');
  }
}
