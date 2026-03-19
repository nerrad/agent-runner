import { mkdir, writeFile } from 'node:fs/promises';
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
    const branchExplicit = Boolean(job.spec.branch);
    const prompt = buildAgentPrompt(job.spec, job.branchName, branchExplicit);
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

    await mkdir(path.dirname(job.artifacts.promptPath), { recursive: true });
    await mkdir(path.dirname(job.artifacts.schemaPath), { recursive: true });
    await mkdir(path.dirname(job.artifacts.finalResponsePath), { recursive: true });
    await mkdir(path.dirname(job.artifacts.debugLogPath), { recursive: true });
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

function buildAgentPrompt(spec: JobSpec, branchName: string, branchExplicit: boolean): string {
  const lines = [
    'You are running inside agent-runner, an externally sandboxed autonomous worker.',
    `Repository root: /workspace`,
    'Spec entrypoint: /spec/plan.md',
    `Working branch: ${branchName}`,
    `Runtime: ${spec.agentRuntime}`,
    `Model preference: ${spec.model ?? 'runtime default'}`,
    `Effort preference: ${spec.effort}`,
    `Capability profile: ${spec.capabilityProfile}`,
    `Repo access mode: ${spec.repoAccessMode}`,
    `Agent state mode: ${spec.agentStateMode}`,
    '',
    'Requirements:',
    '- Start with /spec/plan.md and work until the plan is complete or a hard blocker prevents progress.',
    '- Read /spec/shape.md, /spec/standards.md, /spec/references.md, and /spec/visuals only when they are relevant to the work.',
    '- Run any relevant build, test, or validation steps yourself.',
    '- If you hit a hard blocker, capture the blocker precisely.',
    '- Your final response must be JSON matching the required schema only.',
    '',
    'Progress reporting:',
    '- Prefer the explicit helper command: ar-emit progress "<message>".',
    '- Use ar-emit progress before each major task or task switch.',
    '- Use ar-emit progress before long-running commands, tests, or builds.',
    '- Use a brief ar-emit progress heartbeat before likely long silent stretches.',
    '- Keep every progress update single-line and terse.',
    '- Plain stdout lines prefixed with [progress] are still accepted for compatibility, but ar-emit progress is the preferred path.',
    '',
    'Blocker rule:',
    '- Use status "blocked" only for missing credentials, missing external access, missing required files, or irreducible ambiguity.',
    '- Otherwise complete the work and use status "completed".',
  ];

  if (spec.capabilityProfile === 'dangerous') {
    lines.push('', 'Dangerous mode:', '- Broad host credentials and Docker access may be available.');
  } else {
    lines.push('', 'Brokered host access:', '- Do not expect raw host credentials or the host Docker socket to be available.');
    if (spec.repoAccessMode === 'broker') {
      lines.push('- Use `ar-git` and `ar-gh` for brokered read-only repo inspection.');
      lines.push('- `ar-git-push` — push the working branch (no args needed; uses current branch by default).');
      lines.push('- `ar-pr-create --title "..." --body "..."` — create a pull request. Optional: `--base <branch>`, `--head <branch>`.');
      lines.push('- `ar-pr-comment --pr <number> --body "..."` — comment on an existing PR.');
    }
    if (spec.capabilityProfile === 'docker-broker') {
      lines.push('- Use `ar-docker-compose-up`, `ar-docker-compose-down`, `ar-docker-logs`, `ar-docker-exec`, `ar-wp-env-start`, `ar-wp-env-stop`, `ar-wp-env-run`, and `ar-wp-env-logs` for brokered Docker operations.');
      lines.push('- `wp-env` is available in docker-broker mode; dangerous mode is not required for normal wp-env workflows.');
      lines.push('- Do not expect raw `docker` daemon access inside the worker.');
    }
  }

  if (spec.agentStateMode === 'mounted') {
    lines.push('', 'Mounted agent state:', '- Host agent config, auth, instructions, telemetry, and cost/accounting state may be mounted read-write.');
    lines.push('- Any changes to mounted agent state are audited after the run, but the audit is forensic rather than preventive.');
  } else {
    lines.push('', 'Mounted agent state:', '- Mounted agent state is disabled for stronger isolation.');
  }

  if (!branchExplicit) {
    lines.push(
      '',
      'Branch naming:',
      '- Before pushing, rename the working branch.',
      '- Check the repo for branch naming conventions (CLAUDE.md, CONTRIBUTING.md, .github/CONTRIBUTING.md).',
      '- If conventions are found, follow them.',
      '- Otherwise, rename to: agent-runner/{brief-slug} where the slug is at most 20 lowercase-hyphenated characters summarizing the work.',
    );
    lines.push('- Use `ar-branch-rename <new-name>` to rename.');
  }

  return lines.join('\n');
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
      'PROMPT="$(cat /inputs/prompt.txt)"',
      `${optionParts.join(' ')} --output-schema /inputs/${path.basename(schemaPath)} -o /outputs/${path.basename(outputPath)} "$PROMPT"`,
    ].join('\n'),
  ];
}

function buildClaudeCommand(spec: JobSpec, outputPath: string, debugLogPath: string): string[] {
  const optionParts = [
    'claude -p',
    '--dangerously-skip-permissions',
    '--output-format json',
    `--debug-file ${shellQuote(`/outputs/${path.basename(debugLogPath)}`)}`,
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
      'PROMPT="$(cat /inputs/prompt.txt)"',
      'SCHEMA="$(cat /inputs/result-schema.json)"',
      `${optionParts.join(' ')} --json-schema "$SCHEMA" "$PROMPT" > /outputs/${path.basename(outputPath)}`,
    ].join('\n'),
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', `'\"'\"'`)}'`;
}
