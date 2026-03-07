import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentResult, AgentRuntime, JobRecord, JobSpec } from '../shared/types.js';

export interface PreparedAgentRun {
  command: string[];
  prompt: string;
}

export class AgentAdapters {
  async prepare(job: JobRecord): Promise<PreparedAgentRun> {
    const prompt = buildAgentPrompt(job.spec, job.branchName);
    const schemaJson = JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: [ 'completed', 'blocked' ] },
        summary: { type: 'string' },
        blockerReason: { type: 'string' },
      },
      required: [ 'status', 'summary' ],
    });

    await writeFile(job.artifacts.promptPath, prompt, 'utf8');
    await writeFile(job.artifacts.schemaPath, schemaJson, 'utf8');

    if (job.spec.agentRuntime === 'codex') {
      return {
        prompt,
        command: buildCodexCommand(job.artifacts.schemaPath, job.artifacts.finalResponsePath),
      };
    }

    return {
      prompt,
      command: buildClaudeCommand(job.artifacts.finalResponsePath),
    };
  }

  runtimeEnvKeys(runtime: AgentRuntime): string[] {
    if (runtime === 'claude') {
      return [ 'ANTHROPIC_API_KEY' ];
    }
    return [ 'OPENAI_API_KEY' ];
  }

  async parseResult(job: JobRecord): Promise<AgentResult> {
    const finalContent = await import('node:fs/promises').then((fs) => fs.readFile(job.artifacts.finalResponsePath, 'utf8'));
    const parsed = JSON.parse(finalContent) as AgentResult;
    return parsed;
  }
}

function buildAgentPrompt(spec: JobSpec, branchName: string): string {
  return [
    'You are running inside agent-runner, an externally sandboxed autonomous worker.',
    `Repository root: /workspace`,
    'Spec entrypoint: /spec/plan.md',
    `Working branch: ${branchName}`,
    '',
    'Requirements:',
    '- Start with /spec/plan.md and work until the plan is complete or a hard blocker prevents progress.',
    '- Read /spec/shape.md, /spec/standards.md, /spec/references.md, and /spec/visuals only when they are relevant to the work.',
    '- You have full permissions inside this container. Do not wait for approval prompts.',
    '- Run any relevant build, test, or validation steps yourself.',
    '- If you hit a hard blocker, capture the blocker precisely.',
    '- Your final response must be JSON matching the required schema only.',
    '',
    'Blocker rule:',
    '- Use status "blocked" only for missing credentials, missing external access, missing required files, or irreducible ambiguity.',
    '- Otherwise complete the work and use status "completed".',
  ].join('\n');
}

function buildCodexCommand(schemaPath: string, outputPath: string): string[] {
  return [
    'bash',
    '-lc',
    [
      'set -euo pipefail',
      'PROMPT="$(cat /artifacts/prompt.txt)"',
      `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /workspace --output-schema /artifacts/${path.basename(schemaPath)} -o /artifacts/${path.basename(outputPath)} "$PROMPT"`,
    ].join('\n'),
  ];
}

function buildClaudeCommand(outputPath: string): string[] {
  return [
    'bash',
    '-lc',
    [
      'set -euo pipefail',
      'PROMPT="$(cat /artifacts/prompt.txt)"',
      'SCHEMA="$(cat /artifacts/result-schema.json)"',
      `claude -p --dangerously-skip-permissions --output-format json --json-schema "$SCHEMA" "$PROMPT" > /artifacts/${path.basename(outputPath)}`,
    ].join('\n'),
  ];
}
