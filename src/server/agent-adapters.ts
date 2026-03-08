import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEffort, AgentResult, AgentRuntime, JobRecord, JobSpec } from '../shared/types.js';

export interface PreparedAgentRun {
  command: string[];
  prompt: string;
}

export interface RuntimeAuthPolicy {
  envKey: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
  helperEnvVar: 'AGENT_RUNNER_ANTHROPIC_KEY_HELPER' | 'AGENT_RUNNER_OPENAI_KEY_HELPER';
  allowLocalStateFallback: boolean;
  missingAuthMessage: string;
  authLoopMessage: string;
  authFailurePatterns: RegExp[];
  noisePatterns: RegExp[];
}

const RUNTIME_AUTH_POLICIES: Record<AgentRuntime, RuntimeAuthPolicy> = {
  claude: {
    envKey: 'ANTHROPIC_API_KEY',
    helperEnvVar: 'AGENT_RUNNER_ANTHROPIC_KEY_HELPER',
    allowLocalStateFallback: false,
    missingAuthMessage: 'Claude jobs require ANTHROPIC_API_KEY or AGENT_RUNNER_ANTHROPIC_KEY_HELPER for unattended Docker runs.',
    authLoopMessage: 'Claude authentication failed repeatedly before any meaningful output. Failing the job to avoid an infinite auth loop.',
    authFailurePatterns: [
      /authentication_failed/i,
      /not logged in/i,
      /please run \/login/i,
    ],
    noisePatterns: [
      /^\s*$/,
      /^Started container\b/i,
      /\bStructuredOutput\b/,
    ],
  },
  codex: {
    envKey: 'OPENAI_API_KEY',
    helperEnvVar: 'AGENT_RUNNER_OPENAI_KEY_HELPER',
    allowLocalStateFallback: true,
    missingAuthMessage: 'Codex jobs require OPENAI_API_KEY, AGENT_RUNNER_OPENAI_KEY_HELPER, or a non-empty mounted ~/.codex auth state.',
    authLoopMessage: 'Codex authentication failed repeatedly before any meaningful output. Failing the job to avoid an infinite auth loop.',
    authFailurePatterns: [
      /incorrect api key provided/i,
      /\b401\b.*unauthorized/i,
      /\b403\b.*forbidden/i,
      /\bOPENAI_API_KEY\b/,
      /please run codex --login/i,
      /\bcodex --login\b/i,
    ],
    noisePatterns: [
      /^\s*$/,
      /^Started container\b/i,
      /\bStructuredOutput\b/,
    ],
  },
};

export class AgentAdapters {
  async prepare(job: JobRecord): Promise<PreparedAgentRun> {
    const prompt = buildAgentPrompt(job.spec, job.branchName);
    const schemaJson = JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: [ 'completed', 'blocked' ] },
        summary: { type: 'string' },
        blockerReason: { type: [ 'string', 'null' ] },
      },
      required: [ 'status', 'summary', 'blockerReason' ],
    });

    await writeFile(job.artifacts.promptPath, prompt, 'utf8');
    await writeFile(job.artifacts.schemaPath, schemaJson, 'utf8');

    if (job.spec.agentRuntime === 'codex') {
      return {
        prompt,
        command: buildCodexCommand(job.spec, job.artifacts.schemaPath, job.artifacts.finalResponsePath),
      };
    }

    return {
      prompt,
      command: buildClaudeCommand(job.spec, job.artifacts.finalResponsePath),
    };
  }

  runtimeEnvKeys(runtime: AgentRuntime): string[] {
    return [ this.runtimeAuthPolicy(runtime).envKey ];
  }

  runtimeAuthPolicy(runtime: AgentRuntime): RuntimeAuthPolicy {
    return RUNTIME_AUTH_POLICIES[runtime];
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
    `Runtime: ${spec.agentRuntime}`,
    `Model preference: ${spec.model ?? 'runtime default'}`,
    `Effort preference: ${spec.effort}`,
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

function buildCodexCommand(spec: JobSpec, schemaPath: string, outputPath: string): string[] {
  const optionParts = [
    'codex exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-C /workspace',
  ];

  if (spec.model) {
    optionParts.push(`-m ${shellQuote(spec.model)}`);
  }

  if (spec.effort !== 'auto') {
    optionParts.push(`-c ${shellQuote(`model_reasoning_effort="${spec.effort}"`)}`);
  }

  return [
    'bash',
    '-lc',
    [
      'set -euo pipefail',
      'PROMPT="$(cat /artifacts/prompt.txt)"',
      `${optionParts.join(' ')} --output-schema /artifacts/${path.basename(schemaPath)} -o /artifacts/${path.basename(outputPath)} "$PROMPT"`,
    ].join('\n'),
  ];
}

function buildClaudeCommand(spec: JobSpec, outputPath: string): string[] {
  const optionParts = [
    'claude -p',
    '--dangerously-skip-permissions',
    '--output-format json',
  ];

  if (spec.model) {
    optionParts.push(`--model ${shellQuote(spec.model)}`);
  }

  if (spec.effort !== 'auto') {
    optionParts.push(`--effort ${shellQuote(spec.effort)}`);
  }

  return [
    'bash',
    '-lc',
    [
      'set -euo pipefail',
      'PROMPT="$(cat /artifacts/prompt.txt)"',
      'SCHEMA="$(cat /artifacts/result-schema.json)"',
      `${optionParts.join(' ')} --json-schema "$SCHEMA" "$PROMPT" > /artifacts/${path.basename(outputPath)}`,
    ].join('\n'),
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\"'\"'`)}'`;
}
