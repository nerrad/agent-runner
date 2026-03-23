import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitHostProfile, GitHubHost } from '../shared/types.js';

const VALID_PROXY_SCHEMES = /^(socks5?|https?):\/\//;
import { loadProjectEnv } from './env-file.js';
import { ensureDir, pathExists } from './fs-utils.js';

export interface RuntimeConfig {
  appDir: string;
  jobsDir: string;
  workspacesDir: string;
  artifactsDir: string;
  specRoot: string;
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
  brokerPort: number;
  brokerHost: string;
  brokerUrl: string;
  dockerMemoryLimit?: string;
  dockerCpuLimit?: string;
}

/** Home directory inside the worker Docker container. Must match the Dockerfile. */
export const CONTAINER_HOME = '/home/agent-runner';

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
  const sourceRoot = await resolveSourceRoot(import.meta.url);
  await loadProjectEnv(sourceRoot);
  const appDir = process.env.AGENT_RUNNER_HOME ?? path.join(os.homedir(), '.agent-runner');

  const config: RuntimeConfig = {
    appDir,
    jobsDir: path.join(appDir, 'jobs'),
    workspacesDir: path.join(appDir, 'workspaces'),
    artifactsDir: path.join(appDir, 'artifacts'),
    specRoot: process.env.AGENT_RUNNER_SPEC_ROOT ?? path.join(appDir, 'specs'),
    ghConfigDir: process.env.AGENT_RUNNER_GH_CONFIG ?? path.join(os.homedir(), '.config', 'gh'),
    claudeDir: process.env.AGENT_RUNNER_CLAUDE_DIR ?? path.join(os.homedir(), '.claude'),
    claudeSettingsPath: process.env.AGENT_RUNNER_CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude.json'),
    codexDir: process.env.AGENT_RUNNER_CODEX_DIR ?? path.join(os.homedir(), '.codex'),
    dockerSocketPath: await resolveDockerSocketPath(),
    hostUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    hostGid: typeof process.getgid === 'function' ? process.getgid() : undefined,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
    githubProxyUrl: validateProxyUrl(process.env.AGENT_RUNNER_GITHUB_PROXY_URL),
    workerImageTag: process.env.AGENT_RUNNER_IMAGE ?? 'agent-runner-worker:latest',
    dockerMemoryLimit: process.env.AGENT_RUNNER_DOCKER_MEMORY ?? '8g',
    dockerCpuLimit: process.env.AGENT_RUNNER_DOCKER_CPUS ?? '4',
    sourceRoot,
    brokerPort: Number.parseInt(process.env.AGENT_RUNNER_BROKER_PORT ?? '4318', 10),
    brokerHost: process.env.AGENT_RUNNER_BROKER_HOST ?? 'host.docker.internal',
    brokerUrl: '',
  };
  config.brokerUrl = `http://${config.brokerHost}:${config.brokerPort}`;

  await ensureDir(config.appDir);
  await ensureDir(config.jobsDir);
  await ensureDir(config.workspacesDir);
  await ensureDir(config.artifactsDir);
  await ensureDir(config.specRoot);

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

export function toHostProxyUrl(proxyUrl: string): string {
  return proxyUrl.replaceAll('host.docker.internal', '127.0.0.1');
}

export function getHostProxyUrl(config: RuntimeConfig, githubHost: GitHubHost): string | undefined {
  if (githubHost === 'github.com' || !config.githubProxyUrl) {
    return undefined;
  }
  return toHostProxyUrl(config.githubProxyUrl);
}

function validateProxyUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!VALID_PROXY_SCHEMES.test(value)) {
    throw new Error(`Invalid AGENT_RUNNER_GITHUB_PROXY_URL: must start with socks5://, socks4://, http://, or https:// (got ${value})`);
  }
  return value;
}

/** Build a minimal env for host-side git/gh subprocesses, optionally with HTTPS_PROXY. */
export function buildHostGitEnv(config: RuntimeConfig, githubHost: GitHubHost): NodeJS.ProcessEnv | undefined {
  const proxyUrl = getHostProxyUrl(config, githubHost);
  if (!proxyUrl) {
    return undefined;
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    HTTPS_PROXY: proxyUrl,
    // GH_TOKEN / GITHUB_TOKEN are intentionally excluded: they are typically
    // github.com tokens and would override per-host auth when gh targets an
    // enterprise host.  Omitting them lets gh fall back to its per-host
    // config (~/.config/gh/hosts.yml).
  };
  return env;
}

export function createGitHostProfile(config: RuntimeConfig, host: GitHubHost): GitHostProfile {
  return {
    host,
    ghConfigMountPath: config.ghConfigDir,
    sshAgentForward: true,
    proxyUrl: host !== 'github.com' ? config.githubProxyUrl : undefined,
  };
}
