import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(new URL('../../docker/worker-bin/ar-emit', import.meta.url).pathname);

test('ar-emit progress appends one NDJSON event without writing stdout', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-ar-emit-'));
  const { stdout, stderr } = await execFileAsync('bash', [ scriptPath, 'progress', 'syncing files' ], {
    env: {
      ...process.env,
      AR_OUTPUTS_DIR: outputDir,
    },
  });

  const content = await readFile(path.join(outputDir, 'progress.ndjson'), 'utf8');
  const event = JSON.parse(content.trim()) as { kind: string; message: string; at: string };

  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.equal(event.kind, 'progress');
  assert.equal(event.message, 'syncing files');
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('ar-emit rejects invalid usage with a short help message', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-ar-emit-invalid-'));

  await assert.rejects(
    execFileAsync('bash', [ scriptPath, 'status', 'syncing files' ], {
      env: {
        ...process.env,
        AR_OUTPUTS_DIR: outputDir,
      },
    }),
    (error: unknown) => {
      const execError = error as { code?: number; stdout?: string; stderr?: string };
      assert.equal(execError.code, 1);
      assert.equal(execError.stdout, '');
      assert.match(execError.stderr ?? '', /Usage: ar-emit progress "<message>"/);
      return true;
    },
  );
});
