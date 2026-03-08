import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { RuntimeConfig } from '../server/config.js';
import { createGitHostProfile } from '../server/config.js';
import { buildJobPaths } from '../server/paths.js';

const homeDir = '/home/tester';

const runtimeConfig: RuntimeConfig = {
  appDir: '/tmp/agent-runner',
  jobsDir: '/tmp/agent-runner/jobs',
  workspacesDir: '/tmp/agent-runner/workspaces',
  artifactsDir: '/tmp/agent-runner/artifacts',
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

test('buildJobPaths creates stable artifact layout', () => {
  const paths = buildJobPaths(runtimeConfig, 'job-123');

  assert.equal(paths.jobDir, '/tmp/agent-runner/jobs/job-123');
  assert.equal(paths.workspacePath, '/tmp/agent-runner/workspaces/job-123/repo');
  assert.equal(paths.artifacts.summaryPath, '/tmp/agent-runner/artifacts/job-123/summary.json');
  assert.equal(paths.artifacts.finalResponsePath, '/tmp/agent-runner/artifacts/job-123/final-response.json');
  assert.equal(paths.artifacts.specBundlePath, '/tmp/agent-runner/artifacts/job-123/spec');
});
