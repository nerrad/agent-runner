import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { RuntimeConfig } from '../server/config.js';
import { buildHostGitEnv, createGitHostProfile, getHostProxyUrl, loadRuntimeConfig, resolveSourceRoot, toHostProxyUrl } from '../server/config.js';
import { buildJobPaths } from '../server/paths.js';

const homeDir = '/home/tester';

const runtimeConfig: RuntimeConfig = {
  appDir: '/tmp/agent-runner',
  jobsDir: '/tmp/agent-runner/jobs',
  workspacesDir: '/tmp/agent-runner/workspaces',
  artifactsDir: '/tmp/agent-runner/artifacts',
  specRoot: '/tmp/agent-runner/specs',
  ghConfigDir: path.join(homeDir, '.config', 'gh'),
  claudeDir: path.join(homeDir, '.claude'),
  claudeSettingsPath: path.join(homeDir, '.claude.json'),
  codexDir: path.join(homeDir, '.codex'),
  dockerSocketPath: path.join(homeDir, '.orbstack', 'run', 'docker.sock'),
  hostUid: 501,
  hostGid: 20,
  sshAuthSock: '/tmp/ssh.sock',
  githubProxyUrl: 'socks5://host.docker.internal:8080',
  workerImageTag: 'agent-runner-worker:latest',
  sourceRoot: path.join(homeDir, 'agent-runner'),
  brokerPort: 4318,
  brokerHost: 'host.docker.internal',
  brokerUrl: 'http://host.docker.internal:4318',
};

test('createGitHostProfile adds proxy only for non-github.com hosts', () => {
  const publicHost = createGitHostProfile(runtimeConfig, 'github.com');
  const enterpriseHost = createGitHostProfile(runtimeConfig, 'github.example.com');

  assert.equal(publicHost.host, 'github.com');
  assert.equal(publicHost.proxyUrl, undefined);
  assert.equal(publicHost.ghConfigMountPath, path.join(homeDir, '.config', 'gh'));

  assert.equal(enterpriseHost.host, 'github.example.com');
  assert.equal(enterpriseHost.proxyUrl, 'socks5://host.docker.internal:8080');
});

test('toHostProxyUrl replaces host.docker.internal with 127.0.0.1', () => {
  assert.equal(toHostProxyUrl('socks5://host.docker.internal:8080'), 'socks5://127.0.0.1:8080');
  assert.equal(toHostProxyUrl('socks5://127.0.0.1:8080'), 'socks5://127.0.0.1:8080');
  assert.equal(toHostProxyUrl('http://proxy.corp.example.com:3128'), 'http://proxy.corp.example.com:3128');
});

test('getHostProxyUrl returns undefined for github.com and when no proxy configured', () => {
  assert.equal(getHostProxyUrl(runtimeConfig, 'github.com'), undefined);
  assert.equal(getHostProxyUrl(runtimeConfig, 'github.example.com'), 'socks5://127.0.0.1:8080');

  const noProxyConfig = { ...runtimeConfig, githubProxyUrl: undefined };
  assert.equal(getHostProxyUrl(noProxyConfig, 'github.example.com'), undefined);
});

test('buildHostGitEnv returns undefined for github.com (no proxy needed)', () => {
  assert.equal(buildHostGitEnv(runtimeConfig, 'github.com'), undefined);
});

test('buildHostGitEnv returns minimal env with HTTPS_PROXY for enterprise hosts', () => {
  const env = buildHostGitEnv(runtimeConfig, 'github.example.com');
  assert.ok(env);
  assert.equal(env.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.HOME, process.env.HOME);
  // Should NOT contain arbitrary process.env keys like ANTHROPIC_API_KEY
  const keys = Object.keys(env);
  assert.ok(keys.includes('PATH'));
  assert.ok(keys.includes('HTTPS_PROXY'));
  assert.ok(!keys.includes('ANTHROPIC_API_KEY'));
});

test('buildHostGitEnv returns undefined when no proxy is configured', () => {
  const noProxyConfig = { ...runtimeConfig, githubProxyUrl: undefined };
  assert.equal(buildHostGitEnv(noProxyConfig, 'github.example.com'), undefined);
});

test('buildJobPaths creates stable artifact layout', () => {
  const paths = buildJobPaths(runtimeConfig, 'job-123');

  assert.equal(paths.jobDir, '/tmp/agent-runner/jobs/job-123');
  assert.equal(paths.workspacePath, '/tmp/agent-runner/workspaces/job-123/repo');
  assert.equal(paths.artifacts.summaryPath, '/tmp/agent-runner/artifacts/job-123/summary.json');
  assert.equal(paths.artifacts.debugLogPath, '/tmp/agent-runner/artifacts/job-123/outputs/debug.log');
  assert.equal(paths.artifacts.securityAuditPath, '/tmp/agent-runner/artifacts/job-123/security-audit.jsonl');
  assert.equal(paths.artifacts.progressEventsPath, '/tmp/agent-runner/artifacts/job-123/outputs/progress.ndjson');
  assert.equal(paths.artifacts.finalResponsePath, '/tmp/agent-runner/artifacts/job-123/outputs/final-response.json');
  assert.equal(paths.artifacts.specBundlePath, '/tmp/agent-runner/artifacts/job-123/spec');
  assert.equal(paths.artifacts.inputsDir, '/tmp/agent-runner/artifacts/job-123/inputs');
  assert.equal(paths.artifacts.outputsDir, '/tmp/agent-runner/artifacts/job-123/outputs');
});

test('loadRuntimeConfig resolves the repository root for docker assets', async () => {
  const config = await loadRuntimeConfig();

  assert.match(config.sourceRoot, /\/agent-runner$/);
});

test('resolveSourceRoot returns the repository root for source modules', async () => {
  const resolved = await resolveSourceRoot(new URL('../server/config.ts', import.meta.url).href);

  assert.match(resolved, /\/agent-runner$/);
});

test('resolveSourceRoot returns the repository root for built modules under dist', async () => {
  const simulatedBuiltModuleUrl = new URL('../../dist/server/server/config.js', import.meta.url).href;
  const resolved = await resolveSourceRoot(simulatedBuiltModuleUrl);

  assert.match(resolved, /\/agent-runner$/);
});
