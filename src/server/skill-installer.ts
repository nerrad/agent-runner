import path from 'node:path';
import type { RuntimeConfig } from './config.js';
import { copyRecursive, ensureDir, pathExists, safeRemove } from './fs-utils.js';

const SKILL_NAMES = [ 'launch-agent-runner-spec' ] as const;

export interface InstallSkillsOptions {
  force?: boolean;
  targets: Array<'claude' | 'codex'>;
}

export interface InstalledSkill {
  name: string;
  target: 'claude' | 'codex';
  destination: string;
}

export async function installSkills(
  config: RuntimeConfig,
  targetRootResolver: (target: 'claude' | 'codex') => string,
  options: InstallSkillsOptions,
): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = [];

  for (const target of options.targets) {
    const targetRoot = targetRootResolver(target);
    await ensureDir(targetRoot);

    for (const skillName of SKILL_NAMES) {
      const sourcePath = path.join(config.sourceRoot, 'skills', skillName);
      const destination = path.join(targetRoot, skillName);

      if (!(await pathExists(sourcePath))) {
        throw new Error(`Missing canonical skill: ${sourcePath}`);
      }

      if (await pathExists(destination)) {
        if (!options.force) {
          throw new Error(`Skill already exists: ${destination}. Re-run with --force to overwrite.`);
        }
        await safeRemove(destination);
      }

      await copyRecursive(sourcePath, destination);
      installed.push({ name: skillName, target, destination });
    }
  }

  return installed;
}
