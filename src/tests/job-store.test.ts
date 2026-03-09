import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { RuntimeConfig } from '../server/config.js';
import { JobStore } from '../server/job-store.js';
import { writeJsonAtomic } from '../server/fs-utils.js';

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

test('job store backfills sidecar artifact paths for legacy persisted jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-job-store-'));
  const config = createRuntimeConfig(root);
  const store = new JobStore(config);
  const jobId = 'legacy-job';
  const recordPath = path.join(config.jobsDir, jobId, 'job.json');

  await writeJsonAtomic(recordPath, {
    id: jobId,
    status: 'completed',
    workspacePath: '/tmp/workspace',
    branchName: 'agent-runner/legacy-job',
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
      logPath: '/tmp/agent-runner/artifacts/legacy-job/run.log',
      summaryPath: '/tmp/agent-runner/artifacts/legacy-job/summary.json',
      gitDiffPath: '/tmp/agent-runner/artifacts/legacy-job/git.diff',
      agentTranscriptPath: '/tmp/agent-runner/artifacts/legacy-job/agent-transcript.log',
      finalResponsePath: '/tmp/agent-runner/artifacts/legacy-job/final-response.json',
      schemaPath: '/tmp/agent-runner/artifacts/legacy-job/result-schema.json',
      promptPath: '/tmp/agent-runner/artifacts/legacy-job/prompt.txt',
      specBundlePath: '/tmp/agent-runner/artifacts/legacy-job/spec',
    },
  });

  const record = await store.get(jobId);

  assert.ok(record);
  assert.equal(record.artifacts.securityAuditPath, '/tmp/agent-runner/artifacts/legacy-job/security-audit.jsonl');
  assert.equal(record.artifacts.debugLogPath, '/tmp/agent-runner/artifacts/legacy-job/outputs/debug.log');
  assert.equal(record.artifacts.inputsDir, '/tmp/agent-runner/artifacts/legacy-job/inputs');
  assert.equal(record.artifacts.outputsDir, '/tmp/agent-runner/artifacts/legacy-job/outputs');
  assert.equal(record.artifacts.progressEventsPath, '/tmp/agent-runner/artifacts/legacy-job/outputs/progress.ndjson');

  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.artifacts.debugLogPath, '/tmp/agent-runner/artifacts/legacy-job/outputs/debug.log');
  assert.equal(records[0]?.artifacts.progressEventsPath, '/tmp/agent-runner/artifacts/legacy-job/outputs/progress.ndjson');
});
