import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import { AgentAdapters } from '../server/agent-adapters.js';

async function createJobRecord(agentRuntime: 'claude' | 'codex', overrides: Partial<JobRecord['spec']> = {}): Promise<JobRecord> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-adapter-'));
  await mkdir(path.join(tempDir, 'inputs'), { recursive: true });
  await mkdir(path.join(tempDir, 'outputs'), { recursive: true });
  return {
    id: `job-${agentRuntime}`,
    status: 'queued',
    branchName: `agent-runner/job-${agentRuntime}`,
    workspacePath: '/tmp/workspace',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spec: {
      repoUrl: 'git@github.com:owner/repo.git',
      specPath: 'agent-os/specs/example',
      agentRuntime,
      model: overrides.model,
      effort: overrides.effort ?? 'auto',
      githubHost: 'github.com',
      commitOnStop: true,
      wpEnvEnabled: true,
      capabilityProfile: overrides.capabilityProfile ?? 'safe',
      repoAccessMode: overrides.repoAccessMode ?? 'none',
      agentStateMode: overrides.agentStateMode ?? 'mounted',
    },
    artifacts: {
      logPath: path.join(tempDir, 'run.log'),
      debugLogPath: path.join(tempDir, 'outputs', 'debug.log'),
      securityAuditPath: path.join(tempDir, 'security-audit.jsonl'),
      progressEventsPath: path.join(tempDir, 'outputs', 'progress.ndjson'),
      summaryPath: path.join(tempDir, 'summary.json'),
      gitDiffPath: path.join(tempDir, 'git.diff'),
      agentTranscriptPath: path.join(tempDir, 'agent-transcript.log'),
      finalResponsePath: path.join(tempDir, 'outputs', 'final-response.json'),
      schemaPath: path.join(tempDir, 'inputs', 'result-schema.json'),
      promptPath: path.join(tempDir, 'inputs', 'prompt.txt'),
      specBundlePath: path.join(tempDir, 'spec'),
      inputsDir: path.join(tempDir, 'inputs'),
      outputsDir: path.join(tempDir, 'outputs'),
      agentStateSummaryPath: path.join(tempDir, 'agent-state-summary.json'),
      agentStateDiffPath: path.join(tempDir, 'agent-state.diff'),
    },
    resolvedSpec: {
      specMode: 'bundle',
      specEntryPath: '/spec/plan.md',
      specFiles: [ '/spec/plan.md', '/spec/shape.md' ],
    },
  };
}

test('prepare codex run writes prompt/schema and uses exec mode', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('codex', { model: 'o3', effort: 'high' });
  const prepared = await adapters.prepare(job);

  assert.equal(prepared.command[0], 'bash');
  assert.match(prepared.command[2], /codex exec/);
  assert.match(prepared.command[2], /-m 'o3'/);
  assert.match(prepared.command[2], /model_reasoning_effort="high"/);
  assert.match(prepared.command[2], /dangerously-bypass-approvals-and-sandbox/);
  assert.equal(adapters.runtimeEnvKeys('codex')[0], 'OPENAI_API_KEY');

  const prompt = await readFile(job.artifacts.promptPath, 'utf8');
  const schema = await readFile(job.artifacts.schemaPath, 'utf8');
  assert.match(prompt, /Model preference: o3/);
  assert.match(prompt, /Effort preference: high/);
  assert.match(prompt, /Start with \/spec\/plan\.md/);
  assert.match(prompt, /Read \/spec\/shape\.md/);
  assert.match(prompt, /Progress reporting:/);
  assert.match(prompt, /ar-emit progress "<message>"/);
  assert.match(prompt, /Plain stdout lines prefixed with \[progress\]/);
  assert.match(schema, /"completed"/);
  assert.match(schema, /"blockerReason"/);
  assert.match(schema, /"null"/);
});

test('prepare claude run uses print mode with schema', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude', { model: 'sonnet', effort: 'medium' });
  const prepared = await adapters.prepare(job);

  assert.match(prepared.command[2], /claude -p/);
  assert.match(prepared.command[2], /--model 'sonnet'/);
  assert.match(prepared.command[2], /--effort 'medium'/);
  assert.match(prepared.command[2], /--dangerously-skip-permissions/);
  assert.match(prepared.command[2], /--debug-file '\/outputs\/debug\.log'/);
  assert.equal(adapters.runtimeEnvKeys('claude')[0], 'ANTHROPIC_API_KEY');
});

test('prepare claude run can enable debug logging through env', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude', { model: 'sonnet', effort: 'medium' });
  process.env.AGENT_RUNNER_CLAUDE_DEBUG = 'api,hooks';

  try {
    const prepared = await adapters.prepare(job);
    assert.match(prepared.command[2], /--debug 'api,hooks'/);
    assert.match(prepared.command[2], /--debug-file '\/outputs\/debug\.log'/);
  } finally {
    delete process.env.AGENT_RUNNER_CLAUDE_DEBUG;
  }
});

test('prompt includes branch naming instructions when no explicit branch is given', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude', { capabilityProfile: 'repo-broker', repoAccessMode: 'broker' });
  const prepared = await adapters.prepare(job);

  assert.match(prepared.prompt, /Branch naming:/);
  assert.match(prepared.prompt, /ar-branch-rename/);
  assert.doesNotMatch(prepared.prompt, /git branch -m/);
});

test('prompt excludes branch naming instructions when explicit branch is given', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude', { capabilityProfile: 'repo-broker', repoAccessMode: 'broker' });
  (job.spec as Record<string, unknown>).branch = 'my-explicit-branch';
  const prepared = await adapters.prepare(job);

  assert.doesNotMatch(prepared.prompt, /Branch naming:/);
});

test('prompt uses git branch -m instruction for dangerous mode without explicit branch', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude', { capabilityProfile: 'dangerous', repoAccessMode: 'ambient' });
  const prepared = await adapters.prepare(job);

  assert.match(prepared.prompt, /Branch naming:/);
  assert.match(prepared.prompt, /git branch -m/);
  assert.doesNotMatch(prepared.prompt, /ar-branch-rename/);
});

test('runtime auth policies expose helper commands and auth-loop signatures', () => {
  const adapters = new AgentAdapters();
  const claude = adapters.runtimeAuthPolicy('claude');
  const codex = adapters.runtimeAuthPolicy('codex');

  assert.match(claude.missingAuthMessage, /ANTHROPIC_API_KEY to be set in the host environment/);
  assert.match(codex.missingAuthMessage, /OPENAI_API_KEY to be set in the host environment/);
  assert.match(claude.authFailureMessage, /failing the job immediately/i);
  assert.match(codex.authFailureMessage, /failing the job immediately/i);
  assert.ok(claude.authFailurePatterns.some((pattern) => pattern.test('Please run /login')));
  assert.ok(claude.authFailurePatterns.some((pattern) => pattern.test('invalid x-api-key')));
  assert.ok(codex.authFailurePatterns.some((pattern) => pattern.test('Please run codex --login')));
  assert.ok(claude.noisePatterns.some((pattern) => pattern.test('Started container abc123')));
});

test('parseResult extracts structured_output from claude json envelope', async () => {
  const adapters = new AgentAdapters();
  const job = await createJobRecord('claude', { model: 'sonnet', effort: 'low' });
  await import('node:fs/promises').then((fs) => fs.writeFile(job.artifacts.finalResponsePath, JSON.stringify({
    type: 'result',
    subtype: 'success',
    structured_output: {
      status: 'completed',
      summary: 'package name is agent-runner',
      blockerReason: null,
    },
  }), 'utf8'));

  const parsed = await adapters.parseResult(job);

  assert.deepEqual(parsed, {
    status: 'completed',
    summary: 'package name is agent-runner',
    blockerReason: null,
  });
});
