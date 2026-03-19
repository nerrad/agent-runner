import type { JobRecord } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { buildHostGitEnv } from './config.js';
import { runCommand, type CommandResult } from './process-utils.js';

const ALLOWED_GIT_READ_COMMANDS = new Set([
  'status',
  'diff',
  'show',
  'log',
  'rev-parse',
  'branch',
  'ls-files',
  'grep',
  'remote',
  'fetch',
]);

const ALLOWED_GH_READ_COMMANDS = new Set([
  'repo',
  'pr',
  'issue',
  'run',
  'release',
  'api',
]);

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export class RepoBroker {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly execute: CommandRunner = runCommand,
  ) {}

  private proxyEnv(record: JobRecord): NodeJS.ProcessEnv | undefined {
    return buildHostGitEnv(this.config, record.spec.githubHost);
  }

  private proxyOpts(record: JobRecord): { env?: NodeJS.ProcessEnv } {
    const env = this.proxyEnv(record);
    return env ? { env } : {};
  }

  /** Build env for gh CLI commands: proxy + GH_REPO + GH_HOST (for enterprise hosts). */
  private ghEnv(record: JobRecord): NodeJS.ProcessEnv {
    const env = this.proxyEnv(record);
    const result: NodeJS.ProcessEnv = {
      ...(env ?? process.env),
      GH_REPO: repoSlugFromUrl(record.spec.repoUrl),
    };
    if (record.spec.githubHost !== 'github.com') {
      result.GH_HOST = record.spec.githubHost;
    }
    return result;
  }

  async runGitRead(record: JobRecord, args: string[]): Promise<CommandResult> {
    await validateGitReadArgs(this.execute, record, args);
    return await this.execute('git', [ '-C', record.workspacePath, ...args ], this.proxyOpts(record));
  }

  async runGhRead(record: JobRecord, args: string[]): Promise<CommandResult> {
    validateGhReadArgs(args);
    return await this.execute('gh', [ ...args ], {
      cwd: record.workspacePath,
      env: this.ghEnv(record),
    });
  }

  async fetch(record: JobRecord, remote = 'origin'): Promise<CommandResult> {
    await validateFetchTarget(this.execute, record, remote);
    return await this.execute('git', [ '-C', record.workspacePath, 'fetch', remote ], this.proxyOpts(record));
  }

  async createBranch(record: JobRecord, branchName: string): Promise<CommandResult> {
    if (!branchName.trim()) {
      throw new Error('Missing branch name');
    }
    assertWritableBranch(record, branchName);
    return await this.execute('git', [ '-C', record.workspacePath, 'checkout', '-b', branchName ]);
  }

  async pushBranch(
    record: JobRecord,
    options: { remote?: string; branch?: string } = {},
  ): Promise<CommandResult> {
    const remote = options.remote ?? 'origin';
    if (remote !== 'origin') {
      throw new Error('Brokered push is limited to origin');
    }

    const branchName = options.branch ?? record.branchName;
    assertWritableBranch(record, branchName);
    return await this.execute('git', [ '-C', record.workspacePath, 'push', 'origin', `${branchName}:${branchName}` ], this.proxyOpts(record));
  }

  async renameBranch(record: JobRecord, newBranchName: string): Promise<CommandResult> {
    if (!newBranchName.trim()) {
      throw new Error('Missing new branch name');
    }
    assertWritableBranch(record, newBranchName);
    return await this.execute('git', [ '-C', record.workspacePath, 'branch', '-m', newBranchName ]);
  }

  async openPr(
    record: JobRecord,
    options: { title: string; body?: string; base?: string; head?: string },
  ): Promise<CommandResult> {
    if (!options.title.trim()) {
      throw new Error('Missing PR title');
    }
    if (options.title.startsWith('--') || options.title.startsWith('-')) {
      throw new Error(
        'PR title appears to be a CLI flag. '
        + 'Use: ar-pr-create --title "PR title" --body "description" [--base trunk] [--head branch]',
      );
    }
    const head = options.head ?? record.branchName;
    assertWritableBranch(record, head);
    const args = [ 'pr', 'create', '--head', head, '--title', options.title ];
    if (options.body) {
      args.push('--body', options.body);
    }
    if (options.base) {
      args.push('--base', options.base);
    }
    return await this.execute('gh', args, {
      cwd: record.workspacePath,
      env: this.ghEnv(record),
    });
  }

  async commentPr(
    record: JobRecord,
    options: { pr: string; body: string },
  ): Promise<CommandResult> {
    if (!options.pr.trim() || !options.body.trim()) {
      throw new Error('Missing PR comment arguments');
    }
    return await this.execute('gh', [ 'pr', 'comment', options.pr, '--body', options.body ], {
      cwd: record.workspacePath,
      env: this.ghEnv(record),
    });
  }
}

async function validateGitReadArgs(execute: CommandRunner, record: JobRecord, args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new Error('Missing git command');
  }

  const [ command, ...rest ] = args;
  if (!ALLOWED_GIT_READ_COMMANDS.has(command)) {
    throw new Error(`Unsupported brokered git command: ${command}`);
  }

  if (command === 'branch' && rest.some((arg) => ![ '--show-current', '--list', '-a' ].includes(arg))) {
    throw new Error('Only read-only git branch flags are allowed');
  }

  if (command === 'remote') {
    validateGitRemoteArgs(rest);
    return;
  }

  if (command === 'fetch') {
    if (rest.length === 0) {
      return;
    }
    const [ target ] = rest;
    if (!target || target.startsWith('-')) {
      return;
    }
    await validateFetchTarget(execute, record, target);
  }

  if (rest.some((arg) => [ '--delete', '-d', '-D', '--move', '-m', '--rename' ].includes(arg))) {
    throw new Error('Destructive git flags are not allowed');
  }
}

function validateGitRemoteArgs(args: string[]): void {
  if (args.length === 0) {
    return;
  }

  if (args.length === 1 && args[0] === '-v') {
    return;
  }

  const [ subcommand, ...rest ] = args;
  if (subcommand === 'get-url' || subcommand === 'show') {
    if (rest.length !== 1 || !rest[0] || rest[0].startsWith('-')) {
      throw new Error(`git remote ${subcommand} requires a remote name`);
    }
    return;
  }

  throw new Error('Only read-only git remote inspection is allowed');
}

function validateGhReadArgs(args: string[]): void {
  if (args.length === 0) {
    throw new Error('Missing gh command');
  }

  const [ command, ...rest ] = args;
  if (!ALLOWED_GH_READ_COMMANDS.has(command)) {
    throw new Error(`Unsupported brokered gh command: ${command}`);
  }

  if (command === 'api') {
    validateGhApiArgs(rest);
    return;
  }

  if (rest.some((arg) => MUTATING_GH_TOKENS.has(arg))) {
    throw new Error('Mutating gh subcommands are not allowed in read mode');
  }
}

const MUTATING_GH_TOKENS = new Set([
  'edit',
  'close',
  'reopen',
  'merge',
  'delete',
  'create',
  'comment',
]);

function validateGhApiArgs(args: string[]): void {
  const flags = parseArgs(args);
  const method = findFlagValue(flags, '--method') ?? findFlagValue(flags, '-X') ?? 'GET';
  if (method.toUpperCase() !== 'GET') {
    throw new Error('Only gh api GET requests are allowed');
  }

  const pathArg = flags.positionals.find((value) => value.startsWith('/')) ?? '';
  if (pathArg === '/graphql' || pathArg.endsWith('/graphql')) {
    throw new Error('gh api /graphql is not allowed in read mode');
  }

  for (const bodyFlag of [ '--input', '-f', '-F', '--field', '--raw-field' ]) {
    if (flags.present.has(bodyFlag)) {
      throw new Error(`gh api ${bodyFlag} is not allowed in read mode`);
    }
  }
}

async function validateFetchTarget(execute: CommandRunner, record: JobRecord, target: string): Promise<void> {
  if (looksLikeRemoteUrl(target)) {
    return;
  }

  const result = await execute('git', [ '-C', record.workspacePath, 'remote' ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to inspect configured remotes');
  }

  const remoteNames = new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  if (!remoteNames.has(target)) {
    throw new Error(`Unknown git remote: ${target}`);
  }
}

const VALID_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._\/-]*$/;

export function isValidBranchName(name: string): boolean {
  if (!name || !VALID_BRANCH_NAME.test(name)) {
    return false;
  }
  if (name.includes('..') || name.includes('~') || name.includes('^') || name.includes(':') || name.includes('\\') || name.includes(' ')) {
    return false;
  }
  if (name.endsWith('.lock') || name.endsWith('/') || name.endsWith('.')) {
    return false;
  }
  return true;
}

function assertWritableBranch(record: JobRecord, branchName: string): void {
  if (!branchName.trim()) {
    throw new Error('Missing branch name');
  }

  if (!isValidBranchName(branchName)) {
    throw new Error(`Invalid branch name: "${branchName}". Expected a git branch name like "feat/my-feature".`);
  }

  if (!record.defaultBranch) {
    throw new Error('Missing default branch metadata for brokered repo writes');
  }

  if (branchName === record.defaultBranch) {
    throw new Error(`Brokered writes cannot target the default branch (${record.defaultBranch})`);
  }
}

function looksLikeRemoteUrl(value: string): boolean {
  return /^(git@|ssh:\/\/|https?:\/\/)/.test(value);
}

function repoSlugFromUrl(repoUrl: string): string {
  return repoUrl
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '');
}

function parseArgs(args: string[]): {
  present: Set<string>;
  values: Map<string, string>;
  positionals: string[];
} {
  const present = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const [ flag, inlineValue ] = arg.split('=', 2);
    present.add(flag);
    if (inlineValue !== undefined) {
      values.set(flag, inlineValue);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith('-')) {
      values.set(flag, next);
      index += 1;
    }
  }

  return { present, values, positionals };
}

function findFlagValue(
  parsed: { present: Set<string>; values: Map<string, string> },
  flag: string,
): string | undefined {
  return parsed.present.has(flag) ? parsed.values.get(flag) : undefined;
}
