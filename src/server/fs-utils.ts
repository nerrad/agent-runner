import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
}

export async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const directory = path.dirname(targetPath);
  const tempPath = `${targetPath}.tmp`;
  await ensureDir(directory);
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(tempPath, targetPath);
}

export async function readJsonFile<T>(targetPath: string): Promise<T | null> {
  try {
    const content = await readFile(targetPath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function safeRemove(targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function copyRecursive(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory()) {
    await ensureDir(targetPath);
    const entries = await readdir(sourcePath, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const nextSource = path.join(sourcePath, entry.name);
      const nextTarget = path.join(targetPath, entry.name);
      await copyRecursive(nextSource, nextTarget);
    }));
    return;
  }

  await ensureDir(path.dirname(targetPath));
  await copyFile(sourcePath, targetPath);
}
