import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stageSpecBundle } from '../server/spec-resolver.js';

test('stageSpecBundle preserves an Agent OS spec directory and detects companion files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-spec-bundle-'));
  const workspace = path.join(root, 'workspace');
  const source = path.join(workspace, 'agent-os', 'specs', 'feature-x');
  const bundle = path.join(root, 'bundle');

  await mkdir(path.join(source, 'visuals'), { recursive: true });
  await writeFile(path.join(source, 'plan.md'), '# Plan\n', 'utf8');
  await writeFile(path.join(source, 'shape.md'), '# Shape\n', 'utf8');
  await writeFile(path.join(source, 'references.md'), '# References\n', 'utf8');
  await writeFile(path.join(source, 'visuals', 'mock.png'), 'fake', 'utf8');

  const staged = await stageSpecBundle(workspace, 'agent-os/specs/feature-x', bundle);

  assert.equal(staged.resolvedSpec.specMode, 'bundle');
  assert.equal(staged.resolvedSpec.specEntryPath, '/spec/plan.md');
  assert.deepEqual(staged.resolvedSpec.specFiles, [ '/spec/plan.md', '/spec/shape.md', '/spec/references.md' ]);
  assert.equal(staged.resolvedSpec.visualsDir, '/spec/visuals');
  assert.equal(await readFile(path.join(bundle, 'plan.md'), 'utf8'), '# Plan\n');
});

test('stageSpecBundle stages a single file as plan-only mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-spec-file-'));
  const workspace = path.join(root, 'workspace');
  const bundle = path.join(root, 'bundle');
  const planPath = path.join(root, 'plan.md');

  await mkdir(workspace, { recursive: true });
  await writeFile(planPath, '# Plan only\n', 'utf8');

  const staged = await stageSpecBundle(workspace, planPath, bundle);

  assert.equal(staged.resolvedSpec.specMode, 'file');
  assert.deepEqual(staged.resolvedSpec.specFiles, [ '/spec/plan.md' ]);
  assert.equal(await readFile(path.join(bundle, 'plan.md'), 'utf8'), '# Plan only\n');
});
