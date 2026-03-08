import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { normalizeRunSpec, parseCliArgs, resolveSkillTargetRoot } from '../server/cli-utils.js';
import { runCommand } from '../server/process-utils.js';

test('parseCliArgs handles run and installer commands', () => {
  const run = parseCliArgs([
    'run',
    '--repo', '/tmp/repo',
    '--spec', 'agent-os/specs/example',
    '--runtime', 'claude',
    '--model', 'sonnet',
    '--effort', 'high',
    '--host', 'github.example.com',
    '--detach',
  ]);

  assert.deepEqual(run, {
    command: 'run',
    repo: '/tmp/repo',
    spec: 'agent-os/specs/example',
    runtime: 'claude',
    model: 'sonnet',
    effort: 'high',
    host: 'github.example.com',
    ref: undefined,
    detach: true,
  });

  const install = parseCliArgs([ 'skills', 'install', '--force', '--claude-only' ]);
  assert.deepEqual(install, {
    command: 'skills-install',
    force: true,
    claudeOnly: true,
    codexOnly: false,
  });
});

test('normalizeRunSpec converts a local repo path into a remote url and repo-relative spec path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-cli-local-'));
  await mkdir(path.join(root, 'agent-os', 'specs', 'example'), { recursive: true });
  await writeFile(path.join(root, 'agent-os', 'specs', 'example', 'plan.md'), '# Plan\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Repo\n', 'utf8');

  await runCommand('git', [ 'init', root ]);
  await runCommand('git', [ '-C', root, 'config', 'user.name', 'agent-runner-tests' ]);
  await runCommand('git', [ '-C', root, 'config', 'user.email', 'agent-runner-tests@example.com' ]);
  await runCommand('git', [ '-C', root, 'add', '-A' ]);
  await runCommand('git', [ '-C', root, 'commit', '-m', 'init' ]);
  await runCommand('git', [ '-C', root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git' ]);
  await runCommand('git', [ '-C', root, 'checkout', '-b', 'feature/spec-bundle' ]);

  const normalized = await normalizeRunSpec({
    command: 'run',
    repo: root,
    spec: 'agent-os/specs/example',
    runtime: 'codex',
    model: 'o3',
    effort: 'medium',
    host: 'github.com',
    detach: false,
  });

  assert.equal(normalized.jobSpec.repoUrl, 'git@github.com:owner/repo.git');
  assert.equal(normalized.jobSpec.ref, 'feature/spec-bundle');
  assert.equal(normalized.jobSpec.specPath, 'agent-os/specs/example');
  assert.equal(normalized.jobSpec.model, 'o3');
  assert.equal(normalized.jobSpec.effort, 'medium');
});

test('normalizeRunSpec rejects absolute spec paths for git URLs', async () => {
  await assert.rejects(
    () => normalizeRunSpec({
      command: 'run',
      repo: 'git@github.com:owner/repo.git',
      spec: '/tmp/plan.md',
      runtime: 'claude',
      effort: 'auto',
      host: 'github.com',
      detach: false,
    }),
    /repo-relative/,
  );
});

test('resolveSkillTargetRoot maps Claude and Codex install roots', () => {
  assert.match(resolveSkillTargetRoot('claude'), /\/\.claude\/skills$/);
  assert.match(resolveSkillTargetRoot('codex'), /\/\.codex\/skills$/);
});
