import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import { DockerRunner } from '../server/docker-runner.js';

const runtimeConfig: RuntimeConfig = {
  appDir: '/tmp/agent-runner',
  jobsDir: '/tmp/agent-runner/jobs',
  workspacesDir: '/tmp/agent-runner/workspaces',
  artifactsDir: '/tmp/agent-runner/artifacts',
  ghConfigDir: '/Users/dethier/.config/gh',
  claudeDir: '/Users/dethier/.claude',
  claudeSettingsPath: '/Users/dethier/.claude.json',
  codexDir: '/Users/dethier/.codex',
  dockerSocketPath: '/Users/dethier/.orbstack/run/docker.sock',
  sshAuthSock: '/private/tmp/agent.sock',
  a8cProxyUrl: 'socks5://host.docker.internal:8080',
  workerImageTag: 'agent-runner-worker:latest',
  sourceRoot: '/Users/dethier/ai/agent-runner',
};

const jobRecord: JobRecord = {
  id: 'job-123',
  status: 'running',
  branchName: 'agent-runner/job-123',
  workspacePath: '/tmp/agent-runner/workspaces/job-123/repo',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  spec: {
    repoUrl: 'git@github.com:owner/repo.git',
    specPath: 'agent-os/specs/example',
    agentRuntime: 'claude',
    githubHost: 'github.com',
    commitOnStop: true,
    wpEnvEnabled: true,
  },
  artifacts: {
    logPath: '/tmp/agent-runner/artifacts/job-123/run.log',
    summaryPath: '/tmp/agent-runner/artifacts/job-123/summary.json',
    gitDiffPath: '/tmp/agent-runner/artifacts/job-123/git.diff',
    agentTranscriptPath: '/tmp/agent-runner/artifacts/job-123/agent-transcript.log',
    finalResponsePath: '/tmp/agent-runner/artifacts/job-123/final-response.json',
    schemaPath: '/tmp/agent-runner/artifacts/job-123/result-schema.json',
    promptPath: '/tmp/agent-runner/artifacts/job-123/prompt.txt',
    specBundlePath: '/tmp/agent-runner/artifacts/job-123/spec',
  },
  resolvedSpec: {
    specMode: 'bundle',
    specEntryPath: '/spec/plan.md',
    specFiles: [ '/spec/plan.md', '/spec/shape.md' ],
  },
};

test('docker runner mounts local claude/codex state into the worker home', () => {
  const runner = new DockerRunner(runtimeConfig);
  const args = runner.buildRunArgs({
    job: jobRecord,
    command: [ 'bash', '-lc', 'claude --version' ],
    env: { ANTHROPIC_API_KEY: 'ignored-if-login-exists' },
    onLog: () => undefined,
  });

  const commandString = args.join(' ');
  assert.match(commandString, /src=\/Users\/dethier\/\.claude,dst=\/root\/\.claude/);
  assert.match(commandString, /src=\/Users\/dethier\/\.claude\.json,dst=\/root\/\.claude\.json/);
  assert.match(commandString, /src=\/Users\/dethier\/\.codex,dst=\/root\/\.codex/);
  assert.match(commandString, /src=\/tmp\/agent-runner\/artifacts\/job-123\/spec,dst=\/spec,readonly/);
  assert.match(commandString, /HOME=\/root/);
  assert.match(commandString, /GH_CONFIG_DIR=\/gh-config/);
  assert.match(commandString, /SSH_AUTH_SOCK=\/tmp\/agent-runner-ssh\.sock/);
});
