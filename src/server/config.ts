import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { GitHostProfile, GitHubHost } from '../shared/types.js';
import { ensureDir } from './fs-utils.js';

export interface RuntimeConfig {
  appDir: string;
  jobsDir: string;
  workspacesDir: string;
  artifactsDir: string;
  ghConfigDir: string;
  claudeDir: string;
  claudeSettingsPath: string;
  codexDir: string;
  dockerSocketPath: string;
  sshAuthSock?: string;
  a8cProxyUrl: string;
  workerImageTag: string;
  sourceRoot: string;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function resolveDockerSocketPath(): Promise<string> {
  const candidatePaths = [
    process.env.AGENT_RUNNER_DOCKER_SOCKET,
    path.join(os.homedir(), '.orbstack', 'run', 'docker.sock'),
    '/var/run/docker.sock',
  ].filter(Boolean) as string[];

  for (const candidatePath of candidatePaths) {
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  return path.join(os.homedir(), '.orbstack', 'run', 'docker.sock');
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const appDir = process.env.AGENT_RUNNER_HOME ?? path.join(os.homedir(), '.agent-runner');
  const sourceRoot = path.resolve(new URL('../../..', import.meta.url).pathname);

  const config: RuntimeConfig = {
    appDir,
    jobsDir: path.join(appDir, 'jobs'),
    workspacesDir: path.join(appDir, 'workspaces'),
    artifactsDir: path.join(appDir, 'artifacts'),
    ghConfigDir: process.env.AGENT_RUNNER_GH_CONFIG ?? path.join(os.homedir(), '.config', 'gh'),
    claudeDir: process.env.AGENT_RUNNER_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
    claudeSettingsPath: process.env.AGENT_RUNNER_CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude.json'),
    codexDir: process.env.AGENT_RUNNER_CODEX_DIR ?? path.join(os.homedir(), '.codex'),
    dockerSocketPath: await resolveDockerSocketPath(),
    sshAuthSock: process.env.SSH_AUTH_SOCK,
    a8cProxyUrl: process.env.AGENT_RUNNER_A8C_PROXY_URL ?? 'socks5://host.docker.internal:8080',
    workerImageTag: process.env.AGENT_RUNNER_IMAGE ?? 'agent-runner-worker:latest',
    sourceRoot,
  };

  await ensureDir(config.appDir);
  await ensureDir(config.jobsDir);
  await ensureDir(config.workspacesDir);
  await ensureDir(config.artifactsDir);

  return config;
}

export function createGitHostProfile(config: RuntimeConfig, host: GitHubHost): GitHostProfile {
  return {
    host,
    ghConfigMountPath: config.ghConfigDir,
    sshAgentForward: true,
    proxyUrl: host === 'github.a8c.com' ? config.a8cProxyUrl : undefined,
  };
}
