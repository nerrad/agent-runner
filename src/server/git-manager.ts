import { appendFile, writeFile } from 'node:fs/promises';
import type { JobRecord } from '../shared/types.js';
import { ensureDir } from './fs-utils.js';
import { runCommand } from './process-utils.js';

export class GitManager {
  async cloneRepository(repoUrl: string, workspacePath: string, ref?: string): Promise<void> {
    await ensureDir(workspacePath);

    const parentResult = await runCommand('git', [ 'clone', '--origin', 'origin', repoUrl, workspacePath ]);
    if (parentResult.exitCode !== 0) {
      throw new Error(parentResult.stderr || `Failed to clone ${repoUrl}`);
    }

    if (ref) {
      const checkoutResult = await runCommand('git', [ '-C', workspacePath, 'checkout', ref ]);
      if (checkoutResult.exitCode !== 0) {
        throw new Error(checkoutResult.stderr || `Failed to checkout ${ref}`);
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

