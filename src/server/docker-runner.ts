import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { runCommand } from './process-utils.js';

export interface DockerRunRequest {
  job: JobRecord;
  command: string[];
  env: Record<string, string>;
  onLog: (chunk: string) => Promise<void> | void;
  onStart?: (containerId: string) => Promise<void> | void;
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
    const containerName = `agent-runner-${request.job.id}`;
    const sshMountTarget = '/tmp/agent-runner-ssh.sock';
    const ghMountTarget = '/gh-config';

    const dockerArgs = [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerName,
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,src=${request.job.workspacePath},dst=/workspace`,
      '--mount',
      `type=bind,src=${path.dirname(request.job.artifacts.logPath)},dst=/artifacts`,
      '--mount',
      `type=bind,src=${this.config.dockerSocketPath},dst=/var/run/docker.sock`,
      '--mount',
      `type=bind,src=${this.config.ghConfigDir},dst=${ghMountTarget},readonly`,
      '--env',
      `DOCKER_HOST=unix:///var/run/docker.sock`,
      '--env',
      `GH_CONFIG_DIR=${ghMountTarget}`,
      '--env',
      `HOME=/tmp/agent-runner-home`,
    ];

    if (this.config.sshAuthSock) {
      dockerArgs.push('--mount', `type=bind,src=${this.config.sshAuthSock},dst=${sshMountTarget}`);
      dockerArgs.push('--env', `SSH_AUTH_SOCK=${sshMountTarget}`);
    }

    for (const [ key, value ] of Object.entries(request.env)) {
      dockerArgs.push('--env', `${key}=${value}`);
    }

    dockerArgs.push(this.config.workerImageTag, ...request.command);

    const runResult = await runCommand('docker', dockerArgs);
    if (runResult.exitCode !== 0) {
      throw new Error(runResult.stderr || 'Failed to start worker container');
    }

    const containerId = runResult.stdout.trim();
    await request.onLog(`Started container ${containerId}\n`);
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
