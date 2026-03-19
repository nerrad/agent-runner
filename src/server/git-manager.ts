import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobRecord } from '../shared/types.js';
import { ensureDir } from './fs-utils.js';
import { runCommand } from './process-utils.js';

export class GitManager {
  async getRepoRoot(targetPath: string): Promise<string> {
    const result = await runCommand('git', [ '-C', targetPath, 'rev-parse', '--show-toplevel' ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Not a git repository: ${targetPath}`);
    }
    return result.stdout.trim();
  }

  async getOriginUrl(targetPath: string): Promise<string> {
    const result = await runCommand('git', [ '-C', targetPath, 'config', '--get', 'remote.origin.url' ]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`Missing remote.origin.url for ${targetPath}`);
    }
    return result.stdout.trim();
  }

  async getCurrentBranch(targetPath: string): Promise<string> {
    const result = await runCommand('git', [ '-C', targetPath, 'rev-parse', '--abbrev-ref', 'HEAD' ]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`Failed to resolve current branch for ${targetPath}`);
    }
    return result.stdout.trim();
  }

  async getDefaultBranch(targetPath: string, options?: { env?: NodeJS.ProcessEnv }): Promise<string | undefined> {
    const envOpts = options?.env ? { env: options.env } : {};
    const symbolicRef = await runCommand('git', [ '-C', targetPath, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD' ]);
    if (symbolicRef.exitCode === 0 && symbolicRef.stdout.trim()) {
      return symbolicRef.stdout.trim().replace(/^origin\//, '');
    }

    const remoteShow = await runCommand('git', [ '-C', targetPath, 'remote', 'show', 'origin' ], envOpts);
    if (remoteShow.exitCode === 0) {
      const headBranchLine = remoteShow.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('HEAD branch: '));
      if (headBranchLine) {
        const branchName = headBranchLine.replace('HEAD branch: ', '').trim();
        if (branchName) {
          return branchName;
        }
      }
    }

    return undefined;
  }

  async cloneRepository(repoUrl: string, workspacePath: string, options?: { ref?: string; env?: NodeJS.ProcessEnv }): Promise<void> {
    await ensureDir(workspacePath);

    const envOpts = options?.env ? { env: options.env } : {};
    const parentResult = await runCommand('git', [ 'clone', '--origin', 'origin', repoUrl, workspacePath ], envOpts);
    if (parentResult.exitCode !== 0) {
      throw new Error(parentResult.stderr || `Failed to clone ${repoUrl}`);
    }

    if (options?.ref) {
      const checkoutResult = await runCommand('git', [ '-C', workspacePath, 'checkout', options.ref ]);
      if (checkoutResult.exitCode !== 0) {
        throw new Error(checkoutResult.stderr || `Failed to checkout ${options.ref}`);
      }
    }
  }

  async createBranch(workspacePath: string, branchName: string): Promise<void> {
    const result = await runCommand('git', [ '-C', workspacePath, 'checkout', '-b', branchName ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to create branch ${branchName}`);
    }
  }

  async getHeadSha(workspacePath: string): Promise<string> {
    const result = await runCommand('git', [ '-C', workspacePath, 'rev-parse', 'HEAD' ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to read HEAD SHA');
    }
    return result.stdout.trim();
  }

  async getChangedFiles(workspacePath: string): Promise<string[]> {
    const result = await runCommand('git', [ '-C', workspacePath, 'status', '--short' ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Failed to read git status');
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async commitAll(workspacePath: string, message: string): Promise<boolean> {
    await this.ensureExcludePatterns(workspacePath);

    const changedFiles = await this.getChangedFiles(workspacePath);
    if (changedFiles.length === 0) {
      return false;
    }

    const addResult = await runCommand('git', [ '-C', workspacePath, 'add', '-A' ]);
    if (addResult.exitCode !== 0) {
      throw new Error(addResult.stderr || 'Failed to stage changes');
    }

    const commitResult = await runCommand('git', [ '-C', workspacePath, 'commit', '-m', message ]);
    if (commitResult.exitCode !== 0) {
      throw new Error(commitResult.stderr || 'Failed to create commit');
    }

    return true;
  }

  private excludeWrittenFor = new Set<string>();

  private static readonly EXCLUDE_PATTERNS = [
    '.pnpm-store',
    '.yarn/cache',
    '.npm/_cacache',
  ];

  async ensureExcludePatterns(workspacePath: string): Promise<void> {
    if (this.excludeWrittenFor.has(workspacePath)) {
      return;
    }

    const infoDir = join(workspacePath, '.git', 'info');
    await mkdir(infoDir, { recursive: true });

    const excludePath = join(infoDir, 'exclude');
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch {
      // File doesn't exist yet — that's fine
    }

    const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
    const missing = GitManager.EXCLUDE_PATTERNS.filter((p) => !existingLines.has(p));

    if (missing.length > 0) {
      const suffix = (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n';
      await appendFile(excludePath, suffix, 'utf8');
    }

    this.excludeWrittenFor.add(workspacePath);
  }

  async writeDiff(workspacePath: string, targetPath: string): Promise<void> {
    const result = await runCommand('git', [ '-C', workspacePath, 'diff', 'HEAD~1..HEAD' ]);
    await writeFile(targetPath, result.stdout, 'utf8');
  }

  async appendSummary(targetPath: string, record: JobRecord, changedFiles: string[]): Promise<void> {
    const lines = [
      `job=${record.id}`,
      `status=${record.status}`,
      `branch=${record.branchName}`,
      `headSha=${record.headSha ?? ''}`,
      `changedFiles=${changedFiles.length}`,
      ...changedFiles,
      '',
    ];
    await appendFile(targetPath, lines.join('\n'), 'utf8');
  }
}
