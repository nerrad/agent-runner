import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { formatJobSummary, normalizeRunSpec, parseCliArgs, resolveSkillTargetRoot } from '../server/cli-utils.js';
import { runCommand } from '../server/process-utils.js';
import type { RuntimeConfig } from '../server/config.js';

function createRuntimeConfig(root: string): RuntimeConfig {
  return {
    appDir: root,
    jobsDir: path.join(root, 'jobs'),
    workspacesDir: path.join(root, 'workspaces'),
    artifactsDir: path.join(root, 'artifacts'),
    specRoot: path.join(root, 'specs'),
    ghConfigDir: path.join(root, 'gh'),
    claudeDir: path.join(root, 'claude'),
    claudeSettingsPath: path.join(root, '.claude.json'),
    codexDir: path.join(root, 'codex'),
    dockerSocketPath: '/tmp/docker.sock',
    hostUid: 501,
    hostGid: 20,
    sshAuthSock: '/tmp/ssh.sock',
    githubProxyUrl: 'socks5://host.docker.internal:8080',
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: path.resolve(new URL('../..', import.meta.url).pathname),
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
  };
}

test('parseCliArgs handles run and installer commands', () => {
  const init = parseCliArgs([ 'init' ]);
  assert.deepEqual(init, { command: 'init' });

  const logs = parseCliArgs([ 'logs', 'job-123', '--follow', '--debug' ]);
  assert.deepEqual(logs, {
    command: 'logs',
    jobId: 'job-123',
    follow: true,
    kind: 'debug',
  });

  const run = parseCliArgs([
    'run',
    '--repo', '/tmp/repo',
    '--spec', 'agent-os/specs/example',
    '--runtime', 'claude',
    '--model', 'sonnet',
    '--effort', 'high',
    '--host', 'github.example.com',
    '--detach',
  ]);

  assert.deepEqual(run, {
    command: 'run',
    repo: '/tmp/repo',
    spec: 'agent-os/specs/example',
    runtime: 'claude',
    model: 'sonnet',
    effort: 'high',
    host: 'github.example.com',
    ref: undefined,
    branch: undefined,
    detach: true,
    profile: 'safe',
    repoAccess: undefined,
    agentState: 'mounted',
  });

  const install = parseCliArgs([ 'skills', 'install', '--force', '--claude-only' ]);
  assert.deepEqual(install, {
    command: 'skills-install',
    force: true,
    claudeOnly: true,
    codexOnly: false,
  });
});

test('parseCliArgs parses --branch flag', () => {
  const run = parseCliArgs([
    'run',
    '--repo', '/tmp/repo',
    '--spec', 'agent-os/specs/example',
    '--runtime', 'claude',
    '--branch', 'feature/my-branch',
  ]);

  assert.deepEqual(run, {
    command: 'run',
    repo: '/tmp/repo',
    spec: 'agent-os/specs/example',
    runtime: 'claude',
    model: undefined,
    effort: 'auto',
    host: 'github.com',
    ref: undefined,
    branch: 'feature/my-branch',
    detach: false,
    profile: 'safe',
    repoAccess: undefined,
    agentState: 'mounted',
  });
});

test('normalizeRunSpec flows branch through to jobSpec', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cli-branch-'));
  const specRoot = path.join(root, 'specs');
  await mkdir(specRoot, { recursive: true });
  const planPath = path.join(specRoot, 'plan.md');
  await writeFile(planPath, '# Plan\n', 'utf8');
  const config = createRuntimeConfig(root);

  const normalized = await normalizeRunSpec({
    command: 'run',
    repo: 'git@github.com:owner/repo.git',
    spec: planPath,
    runtime: 'claude',
    effort: 'auto',
    host: 'github.com',
    branch: 'my-custom-branch',
    detach: false,
    profile: 'safe',
    repoAccess: undefined,
    agentState: 'mounted',
  }, config);

  assert.equal(normalized.jobSpec.branch, 'my-custom-branch');
});

test('normalizeRunSpec converts a local repo path into a remote url and repo-relative spec path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cli-local-'));
  await mkdir(path.join(root, 'agent-os', 'specs', 'example'), { recursive: true });
  await writeFile(path.join(root, 'agent-os', 'specs', 'example', 'plan.md'), '# Plan\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Repo\n', 'utf8');

  await runCommand('git', [ 'init', root ]);
  await runCommand('git', [ '-C', root, 'config', 'user.name', 'agent-runner-tests' ]);
  await runCommand('git', [ '-C', root, 'config', 'user.email', 'agent-runner-tests@example.com' ]);
  await runCommand('git', [ '-C', root, 'add', '-A' ]);
  await runCommand('git', [ '-C', root, 'commit', '-m', 'init' ]);
  await runCommand('git', [ '-C', root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git' ]);
  await runCommand('git', [ '-C', root, 'checkout', '-b', 'feature/spec-bundle' ]);

  const config = createRuntimeConfig(root);
  const normalized = await normalizeRunSpec({
    command: 'run',
    repo: root,
    spec: 'agent-os/specs/example',
    runtime: 'codex',
    model: 'o3',
    effort: 'medium',
    host: 'github.com',
    detach: false,
    profile: 'safe',
    repoAccess: undefined,
    agentState: 'mounted',
  }, config);

  assert.equal(normalized.jobSpec.repoUrl, 'git@github.com:owner/repo.git');
  assert.equal(normalized.jobSpec.ref, 'feature/spec-bundle');
  assert.equal(normalized.jobSpec.specPath, 'agent-os/specs/example');
  assert.equal(normalized.jobSpec.model, 'o3');
  assert.equal(normalized.jobSpec.effort, 'medium');
  assert.equal(normalized.jobSpec.capabilityProfile, 'safe');
  assert.equal(normalized.jobSpec.agentStateMode, 'mounted');
});

test('normalizeRunSpec accepts absolute spec paths for git URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cli-abs-spec-'));
  const specRoot = path.join(root, 'specs');
  await mkdir(specRoot, { recursive: true });
  const planPath = path.join(specRoot, 'external-plan.md');
  await writeFile(planPath, '# External plan\n', 'utf8');
  const config = createRuntimeConfig(root);

  const normalized = await normalizeRunSpec({
    command: 'run',
    repo: 'git@github.com:owner/repo.git',
    spec: planPath,
    runtime: 'claude',
    effort: 'auto',
    host: 'github.com',
    detach: false,
    profile: 'safe',
    repoAccess: undefined,
    agentState: 'mounted',
  }, config);

  assert.equal(normalized.repoSource, 'url');
  assert.equal(normalized.jobSpec.specPath, planPath);
});

test('normalizeRunSpec auto-derives repoAccessMode from profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cli-access-'));
  const specRoot = path.join(root, 'specs');
  await mkdir(specRoot, { recursive: true });
  const planPath = path.join(specRoot, 'plan.md');
  await writeFile(planPath, '# Plan\n', 'utf8');
  const config = createRuntimeConfig(root);

  const base = {
    command: 'run' as const,
    repo: 'git@github.com:owner/repo.git',
    spec: planPath,
    runtime: 'claude' as const,
    effort: 'auto' as const,
    host: 'github.com',
    detach: false,
    agentState: 'mounted' as const,
  };

  // safe (default) → none
  const safe = await normalizeRunSpec({ ...base, profile: 'safe' }, config);
  assert.equal(safe.jobSpec.repoAccessMode, 'none');

  // repo-broker → broker
  const repoBroker = await normalizeRunSpec({ ...base, profile: 'repo-broker' }, config);
  assert.equal(repoBroker.jobSpec.repoAccessMode, 'broker');

  // docker-broker → broker
  const dockerBroker = await normalizeRunSpec({ ...base, profile: 'docker-broker' }, config);
  assert.equal(dockerBroker.jobSpec.repoAccessMode, 'broker');

  // dangerous without --repo-access → error
  await assert.rejects(
    () => normalizeRunSpec({ ...base, profile: 'dangerous' }, config),
    /dangerous profile requires an explicit --repo-access flag/,
  );

  // dangerous with explicit broker → ok
  const dangerousBroker = await normalizeRunSpec({ ...base, profile: 'dangerous', repoAccess: 'broker' }, config);
  assert.equal(dangerousBroker.jobSpec.repoAccessMode, 'broker');

  // dangerous with explicit ambient → ok
  const dangerousAmbient = await normalizeRunSpec({ ...base, profile: 'dangerous', repoAccess: 'ambient' }, config);
  assert.equal(dangerousAmbient.jobSpec.repoAccessMode, 'ambient');

  // dangerous with explicit none → error
  await assert.rejects(
    () => normalizeRunSpec({ ...base, profile: 'dangerous', repoAccess: 'none' }, config),
    /dangerous jobs cannot use --repo-access none/,
  );

  // safe with explicit broker → error
  await assert.rejects(
    () => normalizeRunSpec({ ...base, profile: 'safe', repoAccess: 'broker' }, config),
    /safe jobs must use --repo-access none/,
  );

  // repo-broker with explicit ambient → error
  await assert.rejects(
    () => normalizeRunSpec({ ...base, profile: 'repo-broker', repoAccess: 'ambient' }, config),
    /repo-broker jobs must use --repo-access broker/,
  );
});

test('parseCliArgs parses explicit --repo-access flag', () => {
  const run = parseCliArgs([
    'run',
    '--repo', '/tmp/repo',
    '--spec', 'spec/plan.md',
    '--runtime', 'claude',
    '--profile', 'dangerous',
    '--repo-access', 'ambient',
  ]);

  assert.equal(run.command, 'run');
  if (run.command === 'run') {
    assert.equal(run.profile, 'dangerous');
    assert.equal(run.repoAccess, 'ambient');
  }
});

test('resolveSkillTargetRoot maps Claude and Codex install roots', () => {
  assert.match(resolveSkillTargetRoot('claude'), /\/\.claude\/skills$/);
  assert.match(resolveSkillTargetRoot('codex'), /\/\.codex\/skills$/);
});

test('formatJobSummary includes blocker reasons when present', () => {
  const summary = formatJobSummary({
    id: 'job-123',
    status: 'failed',
    workspacePath: '/tmp/workspace',
    branchName: 'agent-runner/job-123',
    blockerReason: 'Missing ANTHROPIC_API_KEY',
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
      logPath: '/tmp/log',
      debugLogPath: '/tmp/outputs/debug.log',
      progressEventsPath: '/tmp/outputs/progress.ndjson',
      securityAuditPath: '/tmp/security-audit.jsonl',
      summaryPath: '/tmp/summary.json',
      gitDiffPath: '/tmp/git.diff',
      agentTranscriptPath: '/tmp/transcript.log',
      finalResponsePath: '/tmp/outputs/final.json',
      schemaPath: '/tmp/inputs/schema.json',
      promptPath: '/tmp/inputs/prompt.txt',
      specBundlePath: '/tmp/spec',
      inputsDir: '/tmp/inputs',
      outputsDir: '/tmp/outputs',
      agentStateSummaryPath: '/tmp/agent-state-summary.json',
      agentStateDiffPath: '/tmp/agent-state.diff',
    },
  });

  assert.match(summary, /Missing ANTHROPIC_API_KEY/);
});
