import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { AgentEffort, AgentRuntime, GitHubHost, JobRecord, JobSpec } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { GitManager } from './git-manager.js';

export type CliCommand =
  | {
    command: 'run';
    repo: string;
    spec: string;
    runtime: AgentRuntime;
    model?: string;
    effort: AgentEffort;
    host: GitHubHost;
    ref?: string;
    branch?: string;
    detach: boolean;
    profile: JobSpec['capabilityProfile'];
    repoAccess?: JobSpec['repoAccessMode'];
    agentState: JobSpec['agentStateMode'];
  }
  | { command: 'init' }
  | { command: 'list' }
  | { command: 'show'; jobId: string }
  | { command: 'logs'; jobId: string; follow: boolean; kind: 'run' | 'debug' }
  | { command: 'cancel'; jobId: string }
  | { command: 'skills-install'; force: boolean; claudeOnly: boolean; codexOnly: boolean }
  | { command: 'internal-run'; jobId: string };

export interface NormalizedRunSpec {
  jobSpec: JobSpec;
  repoSource: 'local' | 'url';
  repoRoot?: string;
}

export function parseCliArgs(argv: string[]): CliCommand {
  const [ command, ...rest ] = argv;

  switch (command) {
    case 'run':
      return parseRunArgs(rest);
    case 'init':
      if (rest.length > 0) {
        throw new Error('Usage: agent-runner init');
      }
      return { command: 'init' };
    case 'list':
      return { command: 'list' };
    case 'show':
      if (!rest[0]) {
        throw new Error('Usage: agent-runner show <job-id>');
      }
      return { command: 'show', jobId: rest[0] };
    case 'logs':
      if (!rest[0]) {
        throw new Error('Usage: agent-runner logs <job-id> [--follow] [--debug]');
      }
      return {
        command: 'logs',
        jobId: rest[0],
        follow: rest.includes('--follow'),
        kind: rest.includes('--debug') ? 'debug' : 'run',
      };
    case 'cancel':
      if (!rest[0]) {
        throw new Error('Usage: agent-runner cancel <job-id>');
      }
      return { command: 'cancel', jobId: rest[0] };
    case 'skills':
      if (rest[0] !== 'install') {
        throw new Error('Usage: agent-runner skills install [--force] [--claude-only] [--codex-only]');
      }
      return {
        command: 'skills-install',
        force: rest.includes('--force'),
        claudeOnly: rest.includes('--claude-only'),
        codexOnly: rest.includes('--codex-only'),
      };
    case 'internal-run':
      if (!rest[0]) {
        throw new Error('Usage: agent-runner internal-run <job-id>');
      }
      return { command: 'internal-run', jobId: rest[0] };
    default:
      throw new Error(helpText());
  }
}

function parseRunArgs(args: string[]): CliCommand {
  let repo = '';
  let spec = '';
  let runtime: AgentRuntime = 'claude';
  let model: string | undefined;
  let effort: AgentEffort = 'auto';
  let host: GitHubHost = 'github.com';
  let ref: string | undefined;
  let branch: string | undefined;
  let detach = false;
  let profile: JobSpec['capabilityProfile'] = 'safe';
  let repoAccess: JobSpec['repoAccessMode'] | undefined;
  let agentState: JobSpec['agentStateMode'] = 'mounted';

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case '--repo':
        repo = requireOptionValue(args, ++index, '--repo');
        break;
      case '--spec':
        spec = requireOptionValue(args, ++index, '--spec');
        break;
      case '--runtime':
        runtime = requireRuntime(requireOptionValue(args, ++index, '--runtime'));
        break;
      case '--model':
        model = requireOptionValue(args, ++index, '--model');
        break;
      case '--effort':
        effort = requireEffort(requireOptionValue(args, ++index, '--effort'));
        break;
      case '--host':
        host = requireHost(requireOptionValue(args, ++index, '--host'));
        break;
      case '--ref':
        ref = requireOptionValue(args, ++index, '--ref');
        break;
      case '--branch':
        branch = requireOptionValue(args, ++index, '--branch');
        break;
      case '--detach':
        detach = true;
        break;
      case '--profile':
        profile = requireProfile(requireOptionValue(args, ++index, '--profile'));
        break;
      case '--repo-access':
        repoAccess = requireRepoAccessMode(requireOptionValue(args, ++index, '--repo-access'));
        break;
      case '--agent-state':
        agentState = requireAgentStateMode(requireOptionValue(args, ++index, '--agent-state'));
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (!repo || !spec) {
    throw new Error('Usage: agent-runner run --repo <path-or-url> --spec <path> --runtime <claude|codex> [--model <model>] [--effort <auto|low|medium|high>] [--host <host>] [--ref <ref>] [--branch <name>] [--profile <safe|repo-broker|docker-broker|dangerous>] [--repo-access <none|broker|ambient>] [--agent-state <mounted|none>] [--detach]');
  }

  return {
    command: 'run',
    repo,
    spec,
    runtime,
    model,
    effort,
    host,
    ref,
    branch,
    detach,
    profile,
    repoAccess,
    agentState,
  };
}

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function requireRuntime(value: string): AgentRuntime {
  if (value === 'claude' || value === 'codex') {
    return value;
  }
  throw new Error(`Unsupported runtime: ${value}`);
}

function requireEffort(value: string): AgentEffort {
  if (value === 'auto' || value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  throw new Error(`Unsupported effort: ${value}`);
}

function requireHost(value: string): GitHubHost {
  if (value.trim()) {
    return value;
  }
  throw new Error(`Unsupported GitHub host: ${value}`);
}

function requireProfile(value: string): JobSpec['capabilityProfile'] {
  if (value === 'safe' || value === 'repo-broker' || value === 'docker-broker' || value === 'dangerous') {
    return value;
  }
  throw new Error(`Unsupported profile: ${value}`);
}

function requireRepoAccessMode(value: string): JobSpec['repoAccessMode'] {
  if (value === 'none' || value === 'broker' || value === 'ambient') {
    return value;
  }
  throw new Error(`Unsupported repo access mode: ${value}`);
}

function requireAgentStateMode(value: string): JobSpec['agentStateMode'] {
  if (value === 'mounted' || value === 'none') {
    return value;
  }
  throw new Error(`Unsupported agent state mode: ${value}`);
}

export async function normalizeRunSpec(
  command: Extract<CliCommand, { command: 'run' }>,
  config: RuntimeConfig,
  git = new GitManager(),
): Promise<NormalizedRunSpec> {
  const repoAccess = normalizeRepoAccess(command.profile, command.repoAccess);
  if (looksLikeGitUrl(command.repo)) {
    const specPath = path.isAbsolute(command.spec)
      ? await resolveAbsoluteSpecPath(command.spec, config.specRoot)
      : normalizeRelativePath(command.spec);

    return {
      repoSource: 'url',
      jobSpec: {
        repoUrl: command.repo,
        ref: command.ref,
        branch: command.branch,
        specPath,
        agentRuntime: command.runtime,
        model: command.model,
        effort: command.effort,
        githubHost: command.host,
        commitOnStop: true,
        wpEnvEnabled: true,
        capabilityProfile: command.profile,
        repoAccessMode: repoAccess,
        agentStateMode: command.agentState,
      },
    };
  }

  const repoRoot = await git.getRepoRoot(path.resolve(command.repo));
  const repoUrl = await git.getOriginUrl(repoRoot);
  const ref = command.ref ?? await git.getCurrentBranch(repoRoot);
  const requestedSpec = await resolveSpecPath(command.spec, repoRoot, config.specRoot);

  return {
    repoSource: 'local',
    repoRoot,
    jobSpec: {
      repoUrl,
      ref,
      branch: command.branch,
      specPath: toStoredSpecPath(requestedSpec, repoRoot),
      agentRuntime: command.runtime,
      model: command.model,
      effort: command.effort,
      githubHost: command.host,
      commitOnStop: true,
      wpEnvEnabled: true,
      capabilityProfile: command.profile,
      repoAccessMode: repoAccess,
      agentStateMode: command.agentState,
    },
  };
}

function normalizeRepoAccess(
  profile: JobSpec['capabilityProfile'],
  requested: JobSpec['repoAccessMode'] | undefined,
): JobSpec['repoAccessMode'] {
  // Auto-derive when not explicitly provided
  if (requested === undefined) {
    switch (profile) {
      case 'safe':
        return 'none';
      case 'repo-broker':
      case 'docker-broker':
        return 'broker';
      case 'dangerous':
        throw new Error(
          'dangerous profile requires an explicit --repo-access flag (broker or ambient)',
        );
    }
  }

  // Explicit value provided — validate the pairing
  if (profile === 'dangerous') {
    if (requested === 'none') {
      throw new Error('dangerous jobs cannot use --repo-access none');
    }
    return requested;
  }

  if (profile === 'safe') {
    if (requested !== 'none') {
      throw new Error('safe jobs must use --repo-access none');
    }
    return requested;
  }

  // repo-broker / docker-broker
  if (requested !== 'broker') {
    throw new Error(`${profile} jobs must use --repo-access broker`);
  }

  return requested;
}

async function resolveAbsoluteSpecPath(spec: string, specRoot: string): Promise<string> {
  await assertExists(spec, '--spec');
  const resolved = path.resolve(spec);
  const normalizedRoot = path.resolve(specRoot);
  if (!isInsideRoot(resolved, normalizedRoot)) {
    throw new Error(`Absolute --spec paths must stay inside ${normalizedRoot}`);
  }
  return resolved;
}

async function resolveSpecPath(spec: string, repoRoot: string, specRoot: string): Promise<string> {
  if (path.isAbsolute(spec)) {
    return await resolveAbsoluteSpecPath(spec, specRoot);
  }

  const resolved = path.resolve(repoRoot, spec);
  if (!isInsideRoot(resolved, repoRoot)) {
    throw new Error('Relative --spec paths must stay inside the repo root');
  }

  await assertExists(resolved, '--spec');
  return resolved;
}

async function assertExists(targetPath: string, label: string): Promise<void> {
  try {
    await stat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} not found: ${targetPath}`);
    }
    throw error;
  }
}

function toStoredSpecPath(specPath: string, repoRoot: string): string {
  if (!isInsideRoot(specPath, repoRoot)) {
    return specPath;
  }
  return normalizeRelativePath(path.relative(repoRoot, specPath));
}

function isInsideRoot(targetPath: string, repoRoot: string): boolean {
  const relative = path.relative(repoRoot, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRelativePath(value: string): string {
  const normalized = value.split(path.sep).join('/');
  return normalized.replace(/^\.\//, '');
}

function looksLikeGitUrl(value: string): boolean {
  return /^(git@|ssh:\/\/|https?:\/\/)/.test(value);
}

export function formatJobSummary(record: JobRecord): string {
  const summary = [
    `${record.id}  ${record.status}  ${record.spec.agentRuntime}  ${record.branchName}`,
    `repo=${record.spec.repoUrl}`,
    `spec=${record.spec.specPath}`,
    `model=${record.spec.model ?? 'default'}`,
    `effort=${record.spec.effort}`,
  ];

  if (record.blockerReason) {
    summary.push(`blocker=${record.blockerReason}`);
  }

  if (record.resolvedSpec) {
    summary.push(`resolved=${record.resolvedSpec.specMode} ${record.resolvedSpec.specFiles.join(', ')}`);
  }

  return summary.join('\n');
}

export function defaultSkillTargets(claudeOnly: boolean, codexOnly: boolean): Array<'claude' | 'codex'> {
  if (claudeOnly && codexOnly) {
    throw new Error('Choose at most one of --claude-only or --codex-only');
  }

  if (claudeOnly) {
    return [ 'claude' ];
  }

  if (codexOnly) {
    return [ 'codex' ];
  }

  return [ 'claude', 'codex' ];
}

export function resolveSkillTargetRoot(target: 'claude' | 'codex'): string {
  if (target === 'claude') {
    return path.join(os.homedir(), '.claude', 'skills');
  }
  return path.join(os.homedir(), '.codex', 'skills');
}

export function helpText(): string {
  return [
    'agent-runner commands:',
    '  agent-runner init',
    '  agent-runner run --repo <path-or-url> --spec <path> --runtime <claude|codex> [--model <model>] [--effort <auto|low|medium|high>] [--host <github-host>] [--ref <ref>] [--branch <name>] [--profile <safe|repo-broker|docker-broker|dangerous>] [--repo-access <none|broker|ambient>] [--agent-state <mounted|none>] [--detach]',
    '  agent-runner list',
    '  agent-runner show <job-id>',
    '  agent-runner logs <job-id> [--follow] [--debug]',
    '  agent-runner cancel <job-id>',
    '  agent-runner skills install [--force] [--claude-only] [--codex-only]',
  ].join('\n');
}
