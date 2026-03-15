import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobRecord } from '../shared/types.js';
import { RepoBroker } from '../server/repo-broker.js';

function createJobRecord(): JobRecord {
  return {
    id: 'job-123',
    status: 'running',
    branchName: 'agent-runner/job-123',
    defaultBranch: 'main',
    workspacePath: '/tmp/agent-runner/workspaces/job-123/repo',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: {
      repoUrl: 'git@github.com:owner/repo.git',
      specPath: 'agent-os/specs/example',
      agentRuntime: 'codex',
      effort: 'auto',
      githubHost: 'github.com',
      commitOnStop: true,
      wpEnvEnabled: true,
      capabilityProfile: 'repo-broker',
      repoAccessMode: 'broker',
      agentStateMode: 'mounted',
    },
    artifacts: {
      logPath: '/tmp/agent-runner/artifacts/job-123/run.log',
      debugLogPath: '/tmp/agent-runner/artifacts/job-123/outputs/debug.log',
      securityAuditPath: '/tmp/agent-runner/artifacts/job-123/security-audit.jsonl',
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
  };
}

test('repo broker rejects mutating git remote commands in read mode', async () => {
  const broker = new RepoBroker(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.runGitRead(createJobRecord(), [ 'remote', 'add', 'origin', 'git@github.com:evil/repo.git' ]),
    /read-only git remote inspection/,
  );
});

test('repo broker rejects gh api mutations in read mode', async () => {
  const broker = new RepoBroker(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.runGhRead(createJobRecord(), [ 'api', '/graphql' ]),
    /graphql/,
  );
  await assert.rejects(
    () => broker.runGhRead(createJobRecord(), [ 'api', '/repos/owner/repo/issues', '--method', 'POST' ]),
    /GET requests/,
  );
  await assert.rejects(
    () => broker.runGhRead(createJobRecord(), [ 'api', '/repos/owner/repo/issues', '--field', 'title=test' ]),
    /--field/,
  );
});

test('repo broker allows cross-repo gh reads with --repo', async () => {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const broker = new RepoBroker(async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.runGhRead(createJobRecord(), [ 'repo', 'view', '--repo', 'other/repo' ]);

  assert.equal(calls[0]?.command, 'gh');
  assert.deepEqual(calls[0]?.args, [ 'repo', 'view', '--repo', 'other/repo' ]);
  assert.equal(calls[0]?.env?.GH_REPO, 'owner/repo');
});

test('repo broker allows fetch from configured remotes and blocks unknown remotes', async () => {
  const broker = new RepoBroker(async (_command, args) => {
    if (args.includes('remote')) {
      return { stdout: 'origin\nupstream\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.fetch(createJobRecord(), 'upstream');
  await assert.rejects(
    () => broker.fetch(createJobRecord(), 'evil'),
    /Unknown git remote/,
  );
});

test('repo broker renameBranch succeeds for non-default branches', async () => {
  const calls: Array<string[]> = [];
  const broker = new RepoBroker(async (_command, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.renameBranch(createJobRecord(), 'feature/new-name');
  assert.ok(calls[0]);
  assert.deepEqual(calls[0]?.slice(-3), [ 'branch', '-m', 'feature/new-name' ]);
});

test('repo broker renameBranch rejects renaming to default branch', async () => {
  const broker = new RepoBroker(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), 'main'),
    /default branch/,
  );
});

test('repo broker renameBranch rejects empty branch name', async () => {
  const broker = new RepoBroker(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), ''),
    /Missing new branch name/,
  );
});

test('repo broker limits writes to origin non-default branches', async () => {
  const calls: Array<string[]> = [];
  const broker = new RepoBroker(async (_command, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.pushBranch(createJobRecord(), { branch: 'feature/test' });
  assert.ok(calls[0]);
  assert.deepEqual(calls[0]?.slice(-2), [ 'origin', 'feature/test:feature/test' ]);

  await assert.rejects(
    () => broker.pushBranch(createJobRecord(), { branch: 'main' }),
    /default branch/,
  );
  await assert.rejects(
    () => broker.pushBranch(createJobRecord(), { remote: 'upstream', branch: 'feature/test' }),
    /limited to origin/,
  );
});
