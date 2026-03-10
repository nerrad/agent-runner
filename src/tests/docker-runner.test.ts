import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import { DockerRunner } from '../server/docker-runner.js';

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
  sshAuthSock: '/private/tmp/agent.sock',
  githubProxyUrl: 'socks5://host.docker.internal:8080',
  workerImageTag: 'agent-runner-worker:latest',
  sourceRoot: path.join(homeDir, 'agent-runner'),
  brokerPort: 4318,
  brokerHost: 'host.docker.internal',
  brokerUrl: 'http://host.docker.internal:4318',
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
    effort: 'auto',
    githubHost: 'github.com',
    commitOnStop: true,
    wpEnvEnabled: true,
    capabilityProfile: 'dangerous',
    repoAccessMode: 'ambient',
    agentStateMode: 'mounted',
  },
  artifacts: {
    logPath: '/tmp/agent-runner/artifacts/job-123/run.log',
    debugLogPath: '/tmp/agent-runner/artifacts/job-123/outputs/debug.log',
    securityAuditPath: '/tmp/agent-runner/artifacts/job-123/security-audit.jsonl',
    progressEventsPath: '/tmp/agent-runner/artifacts/job-123/outputs/progress.ndjson',
    summaryPath: '/tmp/agent-runner/artifacts/job-123/summary.json',
    gitDiffPath: '/tmp/agent-runner/artifacts/job-123/git.diff',
    agentTranscriptPath: '/tmp/agent-runner/artifacts/job-123/agent-transcript.log',
    finalResponsePath: '/tmp/agent-runner/artifacts/job-123/outputs/final-response.json',
    schemaPath: '/tmp/agent-runner/artifacts/job-123/inputs/result-schema.json',
    promptPath: '/tmp/agent-runner/artifacts/job-123/inputs/prompt.txt',
    specBundlePath: '/tmp/agent-runner/artifacts/job-123/spec',
    inputsDir: '/tmp/agent-runner/artifacts/job-123/inputs',
    outputsDir: '/tmp/agent-runner/artifacts/job-123/outputs',
    agentStateSummaryPath: '/tmp/agent-runner/artifacts/job-123/agent-state-summary.json',
    agentStateDiffPath: '/tmp/agent-runner/artifacts/job-123/agent-state.diff',
  },
  resolvedSpec: {
    specMode: 'bundle',
    specEntryPath: '/spec/plan.md',
    specFiles: [ '/spec/plan.md', '/spec/shape.md' ],
  },
};

test('docker runner mounts local claude/codex state into the worker home', async () => {
  const runner = new DockerRunner(runtimeConfig);
  const args = await runner.buildRunArgs({
    job: jobRecord,
    command: [ 'bash', '-lc', 'claude --version' ],
    env: { ANTHROPIC_API_KEY: 'ignored-if-login-exists' },
    onLog: () => undefined,
  });

  const commandString = args.join(' ');
  assert.match(commandString, /--user 501:20/);
  assert.match(commandString, /--group-add 0/);
  assert.match(commandString, /src=\/home\/tester\/\.claude,dst=\/home\/agent-runner\/\.claude/);
  assert.match(commandString, /src=\/home\/tester\/\.claude\.json,dst=\/home\/agent-runner\/\.claude\.json/);
  assert.match(commandString, /src=\/home\/tester\/\.codex,dst=\/home\/agent-runner\/\.codex/);
  assert.match(commandString, /src=\/tmp\/agent-runner\/artifacts\/job-123\/spec,dst=\/spec,readonly/);
  assert.match(commandString, /src=\/tmp\/agent-runner\/artifacts\/job-123\/inputs,dst=\/inputs,readonly/);
  assert.match(commandString, /src=\/tmp\/agent-runner\/artifacts\/job-123\/outputs,dst=\/outputs/);
  assert.match(commandString, /HOME=\/home\/agent-runner/);
  assert.match(commandString, /USER=agent-runner/);
  assert.match(commandString, /GH_CONFIG_DIR=\/gh-config/);
  assert.match(commandString, /SSH_AUTH_SOCK=\/tmp\/agent-runner-ssh\.sock/);
});

test('docker runner adds minimum hardening flags for non-dangerous profiles', async () => {
  const runner = new DockerRunner(runtimeConfig);
  const args = await runner.buildRunArgs({
    job: {
      ...jobRecord,
      spec: {
        ...jobRecord.spec,
        capabilityProfile: 'safe',
        repoAccessMode: 'none',
      },
    },
    command: [ 'bash', '-lc', 'codex --version' ],
    env: { OPENAI_API_KEY: 'test-key' },
    onLog: () => undefined,
  });

  const commandString = args.join(' ');
  assert.match(commandString, /--cap-drop=ALL/);
  assert.match(commandString, /--security-opt=no-new-privileges/);
  assert.doesNotMatch(commandString, /GH_CONFIG_DIR=\/gh-config/);
  assert.doesNotMatch(commandString, /SSH_AUTH_SOCK=\/tmp\/agent-runner-ssh\.sock/);
});

test('docker runner injects broker lease env for brokered profiles when request env is missing it', async () => {
  const runner = new DockerRunner(runtimeConfig);
  const brokeredJob: JobRecord = {
    ...jobRecord,
    spec: {
      ...jobRecord.spec,
      capabilityProfile: 'repo-broker',
      repoAccessMode: 'broker',
    },
  };

  await mkdir(path.join(runtimeConfig.jobsDir, brokeredJob.id), { recursive: true });
  await writeFile(
    path.join(runtimeConfig.jobsDir, brokeredJob.id, 'broker-lease.json'),
    JSON.stringify({ token: 'lease-token-123' }),
    'utf8',
  );

  const args = await runner.buildRunArgs({
    job: brokeredJob,
    command: [ 'bash', '-lc', 'env' ],
    env: { ANTHROPIC_API_KEY: 'test-key' },
    onLog: () => undefined,
  });

  const commandString = args.join(' ');
  assert.match(commandString, /AGENT_RUNNER_JOB_ID=job-123/);
  assert.match(commandString, /AGENT_RUNNER_BROKER_URL=http:\/\/host\.docker\.internal:4318/);
  assert.match(commandString, /AGENT_RUNNER_BROKER_TOKEN=lease-token-123/);
});
