import type { JobRecord } from '../shared/types.js';
import { runCommand } from './process-utils.js';

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

export class RepoBroker {
  async runGitRead(record: JobRecord, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    validateGitReadArgs(args);
    return await runCommand('git', [ '-C', record.workspacePath, ...args ]);
  }

  async runGhRead(record: JobRecord, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    validateGhReadArgs(args);
    return await runCommand('gh', [ ...args ], {
      cwd: record.workspacePath,
      env: {
        ...process.env,
        GH_REPO: repoSlugFromUrl(record.spec.repoUrl),
      },
    });
  }

  async fetch(record: JobRecord, remote = 'origin'): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return await runCommand('git', [ '-C', record.workspacePath, 'fetch', remote ]);
  }

  async createBranch(record: JobRecord, branchName: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!branchName.trim()) {
      throw new Error('Missing branch name');
    }
    return await runCommand('git', [ '-C', record.workspacePath, 'checkout', '-b', branchName ]);
  }

  async pushBranch(
    record: JobRecord,
    options: { remote?: string; branch?: string } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const branchName = options.branch ?? record.branchName;
    if (branchName !== record.branchName) {
      throw new Error(`Brokered push is limited to ${record.branchName}`);
    }
    return await runCommand('git', [ '-C', record.workspacePath, 'push', options.remote ?? 'origin', `${branchName}:${branchName}` ]);
  }

  async openPr(
    record: JobRecord,
    options: { title: string; body?: string; base?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!options.title.trim()) {
      throw new Error('Missing PR title');
    }
    const args = [ 'pr', 'create', '--head', record.branchName, '--title', options.title ];
    if (options.body) {
      args.push('--body', options.body);
    }
    if (options.base) {
      args.push('--base', options.base);
    }
    return await runCommand('gh', args, {
      cwd: record.workspacePath,
      env: {
        ...process.env,
        GH_REPO: repoSlugFromUrl(record.spec.repoUrl),
      },
    });
  }

  async commentPr(
    record: JobRecord,
    options: { pr: string; body: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!options.pr.trim() || !options.body.trim()) {
      throw new Error('Missing PR comment arguments');
    }
    return await runCommand('gh', [ 'pr', 'comment', options.pr, '--body', options.body ], {
      cwd: record.workspacePath,
      env: {
        ...process.env,
        GH_REPO: repoSlugFromUrl(record.spec.repoUrl),
      },
    });
  }
}

function validateGitReadArgs(args: string[]): void {
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
  if (rest.some((arg) => [ '--delete', '-d', '-D', '--move', '-m' ].includes(arg))) {
    throw new Error('Destructive git flags are not allowed');
  }
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
    const methodFlag = rest.find((arg, index) => arg === '--method' || rest[index - 1] === '--method');
    if (methodFlag && !rest.includes('GET')) {
      throw new Error('Only gh api GET requests are allowed');
    }
  }
  if (rest.some((arg) => [ 'edit', 'close', 'reopen', 'merge', 'delete', 'create' ].includes(arg))) {
    throw new Error('Mutating gh subcommands are not allowed in read mode');
  }
}

function repoSlugFromUrl(repoUrl: string): string {
  return repoUrl
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '');
}
