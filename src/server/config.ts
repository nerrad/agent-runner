import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitHostProfile, GitHubHost } from '../shared/types.js';
import { ensureDir, pathExists } from './fs-utils.js';

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
  hostUid?: number;
  hostGid?: number;
  sshAuthSock?: string;
  githubProxyUrl?: string;
  workerImageTag: string;
  sourceRoot: string;
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
  const sourceRoot = await resolveSourceRoot(import.meta.url);

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
    hostUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    hostGid: typeof process.getgid === 'function' ? process.getgid() : undefined,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
    githubProxyUrl: process.env.AGENT_RUNNER_GITHUB_PROXY_URL,
    workerImageTag: process.env.AGENT_RUNNER_IMAGE ?? 'agent-runner-worker:latest',
    sourceRoot,
  };

  await ensureDir(config.appDir);
  await ensureDir(config.jobsDir);
  await ensureDir(config.workspacesDir);
  await ensureDir(config.artifactsDir);

  return config;
}

export async function resolveSourceRoot(moduleUrl: string): Promise<string> {
  let currentDir = path.dirname(fileURLToPath(moduleUrl));

  for (;;) {
    if (await pathExists(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '../..');
}

export function createGitHostProfile(config: RuntimeConfig, host: GitHubHost): GitHostProfile {
  return {
    host,
    ghConfigMountPath: config.ghConfigDir,
    sshAgentForward: true,
    proxyUrl: host !== 'github.com' ? config.githubProxyUrl : undefined,
  };
}
