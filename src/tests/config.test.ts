import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeConfig } from '../server/config.js';
import { createGitHostProfile } from '../server/config.js';
import { buildJobPaths } from '../server/paths.js';

const runtimeConfig: RuntimeConfig = {
  appDir: '/tmp/agent-runner',
  jobsDir: '/tmp/agent-runner/jobs',
  workspacesDir: '/tmp/agent-runner/workspaces',
  artifactsDir: '/tmp/agent-runner/artifacts',
  ghConfigDir: '/Users/dethier/.config/gh',
  dockerSocketPath: '/Users/dethier/.orbstack/run/docker.sock',
  sshAuthSock: '/tmp/ssh.sock',
  a8cProxyUrl: 'socks5://host.docker.internal:8080',
  workerImageTag: 'agent-runner-worker:latest',
  sourceRoot: '/Users/dethier/ai/agent-runner',
};

test('createGitHostProfile adds proxy only for github.a8c.com', () => {
  const publicHost = createGitHostProfile(runtimeConfig, 'github.com');
  const enterpriseHost = createGitHostProfile(runtimeConfig, 'github.a8c.com');

  assert.equal(publicHost.host, 'github.com');
  assert.equal(publicHost.proxyUrl, undefined);
  assert.equal(publicHost.ghConfigMountPath, '/Users/dethier/.config/gh');

  assert.equal(enterpriseHost.host, 'github.a8c.com');
  assert.equal(enterpriseHost.proxyUrl, 'socks5://host.docker.internal:8080');
});

test('buildJobPaths creates stable artifact layout', () => {
  const paths = buildJobPaths(runtimeConfig, 'job-123');

  assert.equal(paths.jobDir, '/tmp/agent-runner/jobs/job-123');
  assert.equal(paths.workspacePath, '/tmp/agent-runner/workspaces/job-123/repo');
  assert.equal(paths.artifacts.summaryPath, '/tmp/agent-runner/artifacts/job-123/summary.json');
  assert.equal(paths.artifacts.finalResponsePath, '/tmp/agent-runner/artifacts/job-123/final-response.json');
});

