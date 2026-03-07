import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { ResolvedSpec } from '../shared/types.js';
import { copyRecursive, pathExists, safeRemove } from './fs-utils.js';

const OPTIONAL_SPEC_FILES = [ 'shape.md', 'standards.md', 'references.md' ] as const;

export interface StagedSpecBundle {
  resolvedSpec: ResolvedSpec;
  sourcePath: string;
}

export async function stageSpecBundle(workspacePath: string, specPath: string, bundlePath: string): Promise<StagedSpecBundle> {
  const sourcePath = path.isAbsolute(specPath)
    ? specPath
    : path.join(workspacePath, specPath);

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Spec path not found: ${specPath}`);
    }
    throw error;
  }

  await safeRemove(bundlePath);

  if (sourceStat.isDirectory()) {
    const entryPath = path.join(sourcePath, 'plan.md');
    if (!(await pathExists(entryPath))) {
      throw new Error(`Spec bundle must include plan.md: ${specPath}`);
    }

    await copyRecursive(sourcePath, bundlePath);

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
      resolvedSpec: {
        specMode: 'bundle',
        specEntryPath: '/spec/plan.md',
        specFiles,
        visualsDir,
      },
    };
  }

  await copyRecursive(sourcePath, path.join(bundlePath, 'plan.md'));
  return {
    sourcePath,
    resolvedSpec: {
      specMode: 'file',
      specEntryPath: '/spec/plan.md',
      specFiles: [ '/spec/plan.md' ],
    },
  };
}
