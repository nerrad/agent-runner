import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { GitManager } from '../server/git-manager.js';

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'git-manager-test-'));
  const run = async (...args: string[]) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    await exec('git', args, { cwd: dir });
  };
  await run('init', '-b', 'main');
  await run('config', 'user.email', 'test@test.com');
  await run('config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'initial.txt'), 'hello\n', 'utf8');
  await run('add', '-A');
  await run('commit', '-m', 'initial');
  return dir;
}

test('commitAll writes exclude patterns before staging', async () => {
  const repo = await createTempRepo();
  const gm = new GitManager();

  await writeFile(path.join(repo, 'change.txt'), 'new file\n', 'utf8');
  await mkdir(path.join(repo, '.pnpm-store'), { recursive: true });
  await writeFile(path.join(repo, '.pnpm-store', 'pkg.tgz'), 'data', 'utf8');

  const committed = await gm.commitAll(repo, 'snapshot');
  assert.equal(committed, true);

  const excludeContent = await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(excludeContent, /\.pnpm-store/);
  assert.match(excludeContent, /\.yarn\/cache/);
  assert.match(excludeContent, /\.npm\/_cacache/);

  // .pnpm-store should NOT be in the commit
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const { stdout } = await exec('git', [ 'show', '--name-only', '--format=', 'HEAD' ], { cwd: repo });
  assert.ok(stdout.includes('change.txt'), 'change.txt should be committed');
  assert.ok(!stdout.includes('.pnpm-store'), '.pnpm-store should be excluded from commit');
});

test('commitAll preserves existing content in .git/info/exclude', async () => {
  const repo = await createTempRepo();
  const gm = new GitManager();

  const infoDir = path.join(repo, '.git', 'info');
  await mkdir(infoDir, { recursive: true });
  await writeFile(path.join(infoDir, 'exclude'), '# existing rules\n*.log\n', 'utf8');

  await writeFile(path.join(repo, 'change.txt'), 'new\n', 'utf8');
  await gm.commitAll(repo, 'snapshot');

  const content = await readFile(path.join(infoDir, 'exclude'), 'utf8');
  assert.match(content, /\*\.log/, 'existing patterns should be preserved');
  assert.match(content, /\.pnpm-store/, 'new patterns should be appended');
});

test('commitAll does not duplicate patterns already present in exclude', async () => {
  const repo = await createTempRepo();
  const gm = new GitManager();

  const infoDir = path.join(repo, '.git', 'info');
  await mkdir(infoDir, { recursive: true });
  await writeFile(path.join(infoDir, 'exclude'), '.pnpm-store\n.yarn/cache\n.npm/_cacache\n', 'utf8');

  await writeFile(path.join(repo, 'change.txt'), 'new\n', 'utf8');
  await gm.commitAll(repo, 'snapshot');

  const content = await readFile(path.join(infoDir, 'exclude'), 'utf8');
  const pnpmCount = (content.match(/\.pnpm-store/g) ?? []).length;
  assert.equal(pnpmCount, 1, '.pnpm-store should appear exactly once');
});

test('commitAll returns false when only excluded files are present', async () => {
  const repo = await createTempRepo();
  const gm = new GitManager();

  // Create only files that match exclude patterns — no "real" changes
  await mkdir(path.join(repo, '.pnpm-store'), { recursive: true });
  await writeFile(path.join(repo, '.pnpm-store', 'pkg.tgz'), 'data', 'utf8');
  await mkdir(path.join(repo, '.yarn', 'cache'), { recursive: true });
  await writeFile(path.join(repo, '.yarn', 'cache', 'dep.zip'), 'data', 'utf8');

  const committed = await gm.commitAll(repo, 'snapshot');
  assert.equal(committed, false, 'commitAll should return false when only excluded files exist');
});

test('commitAll only writes exclude patterns once across multiple calls', async () => {
  const repo = await createTempRepo();
  const gm = new GitManager();

  await writeFile(path.join(repo, 'a.txt'), '1\n', 'utf8');
  await gm.commitAll(repo, 'first');

  await writeFile(path.join(repo, 'b.txt'), '2\n', 'utf8');
  await gm.commitAll(repo, 'second');

  const content = await readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  const pnpmCount = (content.match(/\.pnpm-store/g) ?? []).length;
  assert.equal(pnpmCount, 1, 'patterns should be written only once');
});
