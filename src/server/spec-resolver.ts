import path from 'node:path';
import { copyFile, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import type { ResolvedSpec } from '../shared/types.js';
import { pathExists, safeRemove } from './fs-utils.js';

const OPTIONAL_SPEC_FILES = [ 'shape.md', 'standards.md', 'references.md' ] as const;

export interface StagedSpecBundle {
  resolvedSpec: ResolvedSpec;
  sourcePath: string;
  specSourceType: 'repo-relative' | 'external-spec-root';
}

export async function stageSpecBundle(
  workspacePath: string,
  specPath: string,
  bundlePath: string,
  specRoot?: string,
): Promise<StagedSpecBundle> {
  const sourcePath = path.isAbsolute(specPath)
    ? specPath
    : path.join(workspacePath, specPath);
  const sourceType: StagedSpecBundle['specSourceType'] = path.isAbsolute(specPath) ? 'external-spec-root' : 'repo-relative';

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Spec path not found: ${specPath}`);
    }
    throw error;
  }

  if (sourceType === 'repo-relative' || specRoot) {
    await validateSpecSource(sourcePath, sourceType === 'external-spec-root' ? specRoot ?? workspacePath : workspacePath);
  }
  await safeRemove(bundlePath);

  if (sourceStat.isDirectory()) {
    const entryPath = path.join(sourcePath, 'plan.md');
    if (!(await pathExists(entryPath))) {
      throw new Error(`Spec bundle must include plan.md: ${specPath}`);
    }

    await copySpecTree(sourcePath, bundlePath, sourcePath);

    const specFiles = [ '/spec/plan.md' ];
    for (const fileName of OPTIONAL_SPEC_FILES) {
      if (await pathExists(path.join(bundlePath, fileName))) {
        specFiles.push(`/spec/${fileName}`);
      }
    }

    const visualsPath = path.join(bundlePath, 'visuals');
    const visualsDir = await pathExists(visualsPath) ? '/spec/visuals' : undefined;

    return {
      sourcePath,
      specSourceType: sourceType,
      resolvedSpec: {
        specMode: 'bundle',
        specEntryPath: '/spec/plan.md',
        specFiles,
        visualsDir,
      },
    };
  }

  await copySpecTree(sourcePath, path.join(bundlePath, 'plan.md'), path.dirname(sourcePath));
  return {
    sourcePath,
    specSourceType: sourceType,
    resolvedSpec: {
      specMode: 'file',
      specEntryPath: '/spec/plan.md',
      specFiles: [ '/spec/plan.md' ],
    },
  };
}

async function validateSpecSource(sourcePath: string, allowedRoot: string): Promise<void> {
  const normalizedRoot = await realpath(allowedRoot).catch(() => path.resolve(allowedRoot));
  const normalizedSource = await realpath(sourcePath).catch(() => path.resolve(sourcePath));

  if (!isInsideRoot(normalizedSource, normalizedRoot)) {
    throw new Error(`Spec path must stay inside ${normalizedRoot}`);
  }
}

async function copySpecTree(sourcePath: string, targetPath: string, allowedRoot: string): Promise<void> {
  const sourceStat = await lstat(sourcePath);

  if (sourceStat.isSymbolicLink()) {
    const resolved = await realpath(sourcePath);
    const normalizedRoot = await realpath(allowedRoot).catch(() => path.resolve(allowedRoot));
    if (!isInsideRoot(resolved, normalizedRoot)) {
      throw new Error(`Spec symlink escapes allowed root: ${sourcePath}`);
    }
    const resolvedStat = await stat(resolved);
    if (!resolvedStat.isFile() && !resolvedStat.isDirectory()) {
      throw new Error(`Unsupported spec entry: ${sourcePath}`);
    }
    if (resolvedStat.isDirectory()) {
      await copySpecTree(resolved, targetPath, allowedRoot);
      return;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(resolved, targetPath);
    return;
  }

  if (sourceStat.isDirectory()) {
    await mkdir(targetPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const nextSource = path.join(sourcePath, entry.name);
      const nextTarget = path.join(targetPath, entry.name);
      await copySpecTree(nextSource, nextTarget, allowedRoot);
    }));
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported spec entry: ${sourcePath}`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

function isInsideRoot(targetPath: string, root: string): boolean {
  const relative = path.relative(root, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
