import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { ArtifactBundle } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';

const MAX_DIFF_BYTES = 128 * 1024;
const MAX_TEXT_FILE_BYTES = 256 * 1024;

interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  hash: string;
  text: string | null;
}

export interface AgentStateAuditSummary {
  changed: boolean;
  added: string[];
  removed: string[];
  modified: Array<{
    path: string;
    kind: 'text' | 'binary';
    beforeHash: string;
    afterHash: string;
    beforeSize: number;
    afterSize: number;
  }>;
}

export interface AgentStateSnapshot {
  files: Map<string, FileSnapshot>;
}

export class AgentStateAuditor {
  constructor(private readonly config: RuntimeConfig) {}

  async captureSnapshot(): Promise<AgentStateSnapshot> {
    const files = new Map<string, FileSnapshot>();
    await this.walkDirectory(this.config.claudeDir, '.claude', files);
    await this.captureFile(this.config.claudeSettingsPath, '.claude.json', files);
    await this.walkDirectory(this.config.codexDir, '.codex', files);
    return { files };
  }

  async writeAudit(
    artifacts: ArtifactBundle,
    before: AgentStateSnapshot,
    after: AgentStateSnapshot,
  ): Promise<AgentStateAuditSummary> {
    const added: string[] = [];
    const removed: string[] = [];
    const modified: AgentStateAuditSummary['modified'] = [];
    const diffChunks: string[] = [];

    for (const [ relativePath, beforeEntry ] of before.files.entries()) {
      const afterEntry = after.files.get(relativePath);
      if (!afterEntry) {
        removed.push(relativePath);
        continue;
      }

      if (beforeEntry.hash === afterEntry.hash) {
        continue;
      }

      const kind = beforeEntry.text !== null && afterEntry.text !== null ? 'text' : 'binary';
      modified.push({
        path: relativePath,
        kind,
        beforeHash: beforeEntry.hash,
        afterHash: afterEntry.hash,
        beforeSize: beforeEntry.size,
        afterSize: afterEntry.size,
      });

      if (kind === 'text') {
        diffChunks.push(buildUnifiedDiff(relativePath, beforeEntry.text ?? '', afterEntry.text ?? ''));
      }
    }

    for (const [ relativePath ] of after.files.entries()) {
      if (!before.files.has(relativePath)) {
        added.push(relativePath);
      }
    }

    const summary: AgentStateAuditSummary = {
      changed: added.length > 0 || removed.length > 0 || modified.length > 0,
      added: added.sort(),
      removed: removed.sort(),
      modified: modified.sort((left, right) => left.path.localeCompare(right.path)),
    };

    await mkdir(path.dirname(artifacts.agentStateSummaryPath), { recursive: true });
    await writeFile(artifacts.agentStateSummaryPath, JSON.stringify(summary, null, 2), 'utf8');

    const combinedDiff = diffChunks.join('\n');
    await writeFile(
      artifacts.agentStateDiffPath,
      combinedDiff.length > MAX_DIFF_BYTES ? `${combinedDiff.slice(0, MAX_DIFF_BYTES)}\n[agent-runner] diff truncated\n` : combinedDiff,
      'utf8',
    );

    return summary;
  }

  private async walkDirectory(
    absoluteRoot: string,
    relativeRoot: string,
    files: Map<string, FileSnapshot>,
  ): Promise<void> {
    const directoryStat = await stat(absoluteRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!directoryStat?.isDirectory()) {
      return;
    }

    const entries = await readdir(absoluteRoot, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(absoluteRoot, entry.name);
      const relativePath = path.join(relativeRoot, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(absolutePath, relativePath, files);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      await this.captureFile(absolutePath, relativePath, files);
    }
  }

  private async captureFile(
    absolutePath: string,
    relativePath: string,
    files: Map<string, FileSnapshot>,
  ): Promise<void> {
    const fileStat = await stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!fileStat?.isFile()) {
      return;
    }

    const buffer = await readFile(absolutePath);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const text = buffer.length <= MAX_TEXT_FILE_BYTES && isTextBuffer(buffer) ? buffer.toString('utf8') : null;
    files.set(relativePath.split(path.sep).join('/'), {
      relativePath: relativePath.split(path.sep).join('/'),
      absolutePath,
      size: buffer.length,
      mtimeMs: fileStat.mtimeMs,
      hash,
      text,
    });
  }
}

function isTextBuffer(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

function buildUnifiedDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const removed = beforeLines.filter((line, index) => afterLines[index] !== line);
  const added = afterLines.filter((line, index) => beforeLines[index] !== line);
  return [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');
}
