import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEffort, AgentResult, AgentRuntime, JobRecord, JobSpec } from '../shared/types.js';

export interface PreparedAgentRun {
  command: string[];
  prompt: string;
}

export interface RuntimeAuthPolicy {
  envKey: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
  missingAuthMessage: string;
  authFailureMessage: string;
  authFailurePatterns: RegExp[];
  noisePatterns: RegExp[];
}

const RUNTIME_AUTH_POLICIES: Record<AgentRuntime, RuntimeAuthPolicy> = {
  claude: {
    envKey: 'ANTHROPIC_API_KEY',
    missingAuthMessage: 'Claude jobs require ANTHROPIC_API_KEY to be set in the host environment before launch.',
    authFailureMessage: 'Claude authentication failed. Failing the job immediately to avoid waiting on a stuck session.',
    authFailurePatterns: [
      /authentication_failed/i,
      /\bauthentication_error\b/i,
      /invalid x-api-key/i,
      /\b401\b.*unauthorized/i,
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
    missingAuthMessage: 'Codex jobs require OPENAI_API_KEY to be set in the host environment before launch.',
    authFailureMessage: 'Codex authentication failed. Failing the job immediately to avoid waiting on a stuck session.',
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
      command: buildClaudeCommand(job.spec, job.artifacts.finalResponsePath, job.artifacts.debugLogPath),
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
    const parsed = JSON.parse(finalContent) as Record<string, unknown>;

    if (job.spec.agentRuntime === 'claude') {
      const structuredOutput = parsed.structured_output;
      if (structuredOutput && typeof structuredOutput === 'object' && !Array.isArray(structuredOutput)) {
        return structuredOutput as AgentResult;
      }
    }

    return parsed as AgentResult;
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
    'Progress reporting:',
    '- Emit one short plain-text line before each major task or task switch, prefixed with [progress].',
    '- Emit one short [progress] line before long-running commands, tests, or builds.',
    '- Emit a brief [progress] heartbeat before likely long silent stretches.',
    '- Keep every [progress] update single-line and terse.',
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

function buildClaudeCommand(spec: JobSpec, outputPath: string, debugLogPath: string): string[] {
  const optionParts = [
    'claude -p',
    '--dangerously-skip-permissions',
    '--output-format json',
    `--debug-file ${shellQuote(`/artifacts/${path.basename(debugLogPath)}`)}`,
  ];
  const claudeDebug = process.env.AGENT_RUNNER_CLAUDE_DEBUG?.trim();

  if (spec.model) {
    optionParts.push(`--model ${shellQuote(spec.model)}`);
  }

  if (spec.effort !== 'auto') {
    optionParts.push(`--effort ${shellQuote(spec.effort)}`);
  }

  if (claudeDebug) {
    const normalized = claudeDebug.toLowerCase();
    if (claudeDebug !== '1' && normalized !== 'true') {
      optionParts.push(`--debug ${shellQuote(claudeDebug)}`);
    }
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
