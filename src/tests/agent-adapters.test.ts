import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import { AgentAdapters } from '../server/agent-adapters.js';

async function createJobRecord(agentRuntime: 'claude' | 'codex'): Promise<JobRecord> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-adapter-'));
  return {
    id: `job-${agentRuntime}`,
    status: 'queued',
    branchName: `agent-runner/job-${agentRuntime}`,
    workspacePath: '/tmp/workspace',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: {
      repoUrl: 'git@github.com:owner/repo.git',
      planPath: 'docs/plan.md',
      agentRuntime,
      githubHost: 'github.com',
      commitOnStop: true,
      wpEnvEnabled: true,
    },
    artifacts: {
      logPath: path.join(tempDir, 'run.log'),
      summaryPath: path.join(tempDir, 'summary.json'),
      gitDiffPath: path.join(tempDir, 'git.diff'),
      agentTranscriptPath: path.join(tempDir, 'agent-transcript.log'),
      finalResponsePath: path.join(tempDir, 'final-response.json'),
      schemaPath: path.join(tempDir, 'result-schema.json'),
      promptPath: path.join(tempDir, 'prompt.txt'),
    },
  };
}

test('prepare codex run writes prompt/schema and uses exec mode', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('codex');
  const prepared = await adapters.prepare(job);

  assert.equal(prepared.command[0], 'bash');
  assert.match(prepared.command[2], /codex exec/);
  assert.match(prepared.command[2], /dangerously-bypass-approvals-and-sandbox/);
  assert.equal(adapters.requiredEnv('codex')[0], 'OPENAI_API_KEY');

  const prompt = await readFile(job.artifacts.promptPath, 'utf8');
  const schema = await readFile(job.artifacts.schemaPath, 'utf8');
  assert.match(prompt, /Follow the plan file exactly/);
  assert.match(schema, /"completed"/);
});

test('prepare claude run uses print mode with schema', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude');
  const prepared = await adapters.prepare(job);

  assert.match(prepared.command[2], /claude -p/);
  assert.match(prepared.command[2], /--dangerously-skip-permissions/);
  assert.equal(adapters.requiredEnv('claude')[0], 'ANTHROPIC_API_KEY');
});

