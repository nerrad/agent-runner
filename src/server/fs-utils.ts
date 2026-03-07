import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

