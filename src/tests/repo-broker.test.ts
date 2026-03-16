import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from '../server/config.js';
import { RepoBroker, isValidBranchName } from '../server/repo-broker.js';

const testConfig: RuntimeConfig = {
  appDir: '/tmp/agent-runner',
  jobsDir: '/tmp/agent-runner/jobs',
  workspacesDir: '/tmp/agent-runner/workspaces',
  artifactsDir: '/tmp/agent-runner/artifacts',
  specRoot: '/tmp/agent-runner/specs',
  ghConfigDir: '/tmp/gh',
  claudeDir: '/tmp/claude',
  claudeSettingsPath: '/tmp/.claude.json',
  codexDir: '/tmp/codex',
  dockerSocketPath: '/tmp/docker.sock',
  githubProxyUrl: 'socks5://host.docker.internal:8080',
  workerImageTag: 'agent-runner-worker:latest',
  sourceRoot: '/tmp/agent-runner',
  brokerPort: 4318,
  brokerHost: 'host.docker.internal',
  brokerUrl: 'http://host.docker.internal:4318',
};

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
  const broker = new RepoBroker(testConfig, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.runGitRead(createJobRecord(), [ 'remote', 'add', 'origin', 'git@github.com:evil/repo.git' ]),
    /read-only git remote inspection/,
  );
});

test('repo broker rejects gh api mutations in read mode', async () => {
  const broker = new RepoBroker(testConfig, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
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
  const broker = new RepoBroker(testConfig, async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.runGhRead(createJobRecord(), [ 'repo', 'view', '--repo', 'other/repo' ]);

  assert.equal(calls[0]?.command, 'gh');
  assert.deepEqual(calls[0]?.args, [ 'repo', 'view', '--repo', 'other/repo' ]);
  assert.equal(calls[0]?.env?.GH_REPO, 'owner/repo');
});

test('repo broker allows fetch from configured remotes and blocks unknown remotes', async () => {
  const broker = new RepoBroker(testConfig, async (_command, args) => {
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
  const broker = new RepoBroker(testConfig, async (_command, args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.renameBranch(createJobRecord(), 'feature/new-name');
  assert.ok(calls[0]);
  assert.deepEqual(calls[0]?.slice(-3), [ 'branch', '-m', 'feature/new-name' ]);
});

test('repo broker renameBranch rejects renaming to default branch', async () => {
  const broker = new RepoBroker(testConfig, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), 'main'),
    /default branch/,
  );
});

test('repo broker renameBranch rejects empty branch name', async () => {
  const broker = new RepoBroker(testConfig, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), ''),
    /Missing new branch name/,
  );
});

test('isValidBranchName accepts valid names', () => {
  assert.ok(isValidBranchName('feature/my-branch'));
  assert.ok(isValidBranchName('agent-runner/fix-login'));
  assert.ok(isValidBranchName('v1.0.0'));
  assert.ok(isValidBranchName('feature/nested/path'));
});

test('isValidBranchName rejects invalid names', () => {
  assert.equal(isValidBranchName(''), false);
  assert.equal(isValidBranchName('-flag-like'), false);
  assert.equal(isValidBranchName('has..double-dot'), false);
  assert.equal(isValidBranchName('has:colon'), false);
  assert.equal(isValidBranchName('has~tilde'), false);
  assert.equal(isValidBranchName('has^caret'), false);
  assert.equal(isValidBranchName('has space'), false);
  assert.equal(isValidBranchName('has\\backslash'), false);
  assert.equal(isValidBranchName('ends.lock'), false);
  assert.equal(isValidBranchName('ends/'), false);
  assert.equal(isValidBranchName('ends.'), false);
});

test('repo broker renameBranch rejects invalid branch names', async () => {
  const broker = new RepoBroker(testConfig, async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), '-flag-like'),
    /Invalid branch name/,
  );
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), 'has:colon'),
    /Invalid branch name/,
  );
  await assert.rejects(
    () => broker.renameBranch(createJobRecord(), 'has..dots'),
    /Invalid branch name/,
  );
});

test('repo broker limits writes to origin non-default branches', async () => {
  const calls: Array<string[]> = [];
  const broker = new RepoBroker(testConfig, async (_command, args) => {
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

function createEnterpriseJobRecord(): JobRecord {
  const base = createJobRecord();
  return {
    ...base,
    spec: {
      ...base.spec,
      repoUrl: 'git@github.a8c.com:owner/repo.git',
      githubHost: 'github.a8c.com',
    },
  };
}

test('repo broker sets HTTPS_PROXY for enterprise host — runGitRead', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
    capturedEnvs.push(options.env);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.runGitRead(createEnterpriseJobRecord(), [ 'status' ]);
  assert.equal(capturedEnvs[0]?.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
});

test('repo broker sets HTTPS_PROXY for enterprise host — runGhRead', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
    capturedEnvs.push(options.env);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.runGhRead(createEnterpriseJobRecord(), [ 'repo', 'view' ]);
  assert.equal(capturedEnvs[0]?.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
});

test('repo broker sets HTTPS_PROXY for enterprise host — fetch', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, args, options = {}) => {
    capturedEnvs.push(options.env);
    if (args.includes('remote')) {
      return { stdout: 'origin\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.fetch(createEnterpriseJobRecord(), 'origin');
  const fetchEnv = capturedEnvs.find((env) => env?.HTTPS_PROXY !== undefined);
  assert.ok(fetchEnv);
  assert.equal(fetchEnv.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
});

test('repo broker sets HTTPS_PROXY for enterprise host — openPr', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
    capturedEnvs.push(options.env);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.openPr(createEnterpriseJobRecord(), { title: 'Test PR' });
  assert.equal(capturedEnvs[0]?.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
});

test('repo broker sets HTTPS_PROXY for enterprise host — pushBranch', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
    capturedEnvs.push(options.env);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.pushBranch(createEnterpriseJobRecord(), { branch: 'agent-runner/job-123' });
  assert.equal(capturedEnvs[0]?.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
});

test('repo broker sets HTTPS_PROXY for enterprise host — commentPr', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
    capturedEnvs.push(options.env);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.commentPr(createEnterpriseJobRecord(), { pr: '42', body: 'LGTM' });
  assert.equal(capturedEnvs[0]?.HTTPS_PROXY, 'socks5://127.0.0.1:8080');
});

test('repo broker does not set HTTPS_PROXY for github.com hosts', async () => {
  const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
    capturedEnvs.push(options.env);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await broker.runGitRead(createJobRecord(), [ 'status' ]);
  assert.equal(capturedEnvs[0]?.HTTPS_PROXY, undefined);

  await broker.runGhRead(createJobRecord(), [ 'repo', 'view' ]);
  assert.equal(capturedEnvs[1]?.HTTPS_PROXY, undefined);
});

test('repo broker proxy env does not leak process.env secrets', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'secret-test-key';
  try {
    const capturedEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const broker = new RepoBroker(testConfig, async (_command, _args, options = {}) => {
      capturedEnvs.push(options.env);
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await broker.runGitRead(createEnterpriseJobRecord(), [ 'status' ]);
    assert.ok(capturedEnvs[0]);
    assert.equal(capturedEnvs[0].ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedEnvs[0].HTTPS_PROXY, 'socks5://127.0.0.1:8080');
  } finally {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }
});
