import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const brokerEnvScriptPath = path.resolve(new URL('../../docker/worker-bin/ar-broker-env', import.meta.url).pathname);
const brokerRequestScriptPath = path.resolve(new URL('../../docker/worker-bin/ar-broker-request', import.meta.url).pathname);
const wpEnvStartScriptPath = path.resolve(new URL('../../docker/worker-bin/ar-wp-env-start', import.meta.url).pathname);

async function writeBrokerEnvFile(root: string): Promise<string> {
  const brokerEnvPath = path.join(root, 'broker-env.json');
  await writeFile(brokerEnvPath, JSON.stringify({
    AGENT_RUNNER_JOB_ID: 'job-123',
    AGENT_RUNNER_BROKER_URL: 'http://broker.test',
    AGENT_RUNNER_BROKER_TOKEN: 'lease-token-123',
  }), 'utf8');
  return brokerEnvPath;
}

test('ar-broker-env reads broker values from the fallback file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-ar-broker-env-'));
  const brokerEnvPath = await writeBrokerEnvFile(root);

  const { stdout, stderr } = await execFileAsync('bash', [ brokerEnvScriptPath, 'AGENT_RUNNER_JOB_ID' ], {
    env: {
      ...process.env,
      AR_BROKER_ENV_PATH: brokerEnvPath,
    },
  });

  assert.equal(stdout, 'job-123');
  assert.equal(stderr, '');
});

test('ar-wp-env-start resolves the broker job id from the fallback file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-ar-wp-env-start-'));
  const fakeBinDir = path.join(root, 'bin');
  const capturedPath = path.join(root, 'captured.json');
  const brokerEnvPath = await writeBrokerEnvFile(root);

  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(path.join(fakeBinDir, 'ar-broker-request'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'python3 -c \'import json, os, pathlib, sys; pathlib.Path(os.environ["AR_CAPTURE_PATH"]).write_text(json.dumps({"argv": sys.argv[1:]}))\' "$@"',
  ].join('\n'), 'utf8');
  await writeFile(path.join(fakeBinDir, 'ar-broker-env'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `exec bash ${JSON.stringify(brokerEnvScriptPath)} "$@"`,
  ].join('\n'), 'utf8');
  await execFileAsync('chmod', [ '+x', path.join(fakeBinDir, 'ar-broker-request'), path.join(fakeBinDir, 'ar-broker-env') ]);

  const { stdout, stderr } = await execFileAsync('bash', [ wpEnvStartScriptPath, '--xdebug' ], {
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      AR_CAPTURE_PATH: capturedPath,
      AR_BROKER_ENV_PATH: brokerEnvPath,
    },
  });

  const captured = JSON.parse(await readFile(capturedPath, 'utf8')) as { argv: string[] };
  assert.equal(stdout, '');
  assert.equal(stderr, '');
  assert.equal(captured.argv[0], '/broker/jobs/job-123/wp-env/start');
  assert.equal(captured.argv[1], '{"args": ["--xdebug"]}');
});

test('ar-broker-request resolves the broker URL and token from the fallback file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-ar-broker-request-'));
  const fakeBinDir = path.join(root, 'bin');
  const brokerEnvPath = await writeBrokerEnvFile(root);
  const capturePath = path.join(root, 'curl-capture.json');

  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(path.join(fakeBinDir, 'curl'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'OUTPUT_FILE=""',
    'URL=""',
    'PAYLOAD=""',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -o)',
    '      OUTPUT_FILE="$2"',
    '      shift 2',
    '      ;;',
    '    -d)',
    '      PAYLOAD="$2"',
    '      shift 2',
    '      ;;',
    '    http://*|https://*)',
    '      URL="$1"',
    '      shift',
    '      ;;',
    '    *)',
    '      shift',
    '      ;;',
    '  esac',
    'done',
    'python3 -c \'import json, pathlib, sys; pathlib.Path(sys.argv[1]).write_text(json.dumps({"url": sys.argv[2], "payload": sys.argv[3]}))\' "$AR_CAPTURE_PATH" "$URL" "$PAYLOAD"',
    'printf \'{"stdout":"broker ok","stderr":"","exitCode":0}\' > "$OUTPUT_FILE"',
    'printf \'200\'',
  ].join('\n'), 'utf8');
  await writeFile(path.join(fakeBinDir, 'ar-broker-env'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `exec bash ${JSON.stringify(brokerEnvScriptPath)} "$@"`,
  ].join('\n'), 'utf8');
  await execFileAsync('chmod', [ '+x', path.join(fakeBinDir, 'curl'), path.join(fakeBinDir, 'ar-broker-env') ]);

  const { stdout, stderr } = await execFileAsync('bash', [
    brokerRequestScriptPath,
    '/broker/jobs/job-123/wp-env/start',
    '{"args":["--xdebug"]}',
  ], {
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      AR_BROKER_ENV_PATH: brokerEnvPath,
      AR_CAPTURE_PATH: capturePath,
    },
  });

  const captured = JSON.parse(await readFile(capturePath, 'utf8')) as { url: string; payload: string };
  const payload = JSON.parse(captured.payload) as { args: string[]; token: string };

  assert.equal(stdout, 'broker ok');
  assert.equal(stderr, '');
  assert.equal(captured.url, 'http://broker.test/broker/jobs/job-123/wp-env/start');
  assert.deepEqual(payload.args, [ '--xdebug' ]);
  assert.equal(payload.token, 'lease-token-123');
});
