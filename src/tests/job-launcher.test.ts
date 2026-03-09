import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { RuntimeConfig } from '../server/config.js';
import { pathExists } from '../server/fs-utils.js';
import { buildInternalRunnerLaunchCommand, launchDetachedJobRunner } from '../server/job-launcher.js';

function createRuntimeConfig(root: string): RuntimeConfig {
  return {
    appDir: path.join(root, 'app'),
    jobsDir: path.join(root, 'jobs'),
    workspacesDir: path.join(root, 'workspaces'),
    artifactsDir: path.join(root, 'artifacts'),
    specRoot: path.join(root, 'specs'),
    ghConfigDir: path.join(root, 'gh'),
    claudeDir: path.join(root, 'claude'),
    claudeSettingsPath: path.join(root, '.claude.json'),
    codexDir: path.join(root, 'codex'),
    dockerSocketPath: '/tmp/docker.sock',
    hostUid: 501,
    hostGid: 20,
    sshAuthSock: '/tmp/ssh.sock',
    githubProxyUrl: 'socks5://host.docker.internal:8080',
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: root,
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
    uiSessionToken: 'session-token',
  };
}

test('buildInternalRunnerLaunchCommand prefers the source cli with tsx import when available', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-launcher-src-'));
  const config = createRuntimeConfig(root);
  await mkdir(path.join(root, 'src', 'server'), { recursive: true });
  await writeFile(path.join(root, 'src', 'server', 'cli.ts'), 'export {};', 'utf8');

  const launch = await buildInternalRunnerLaunchCommand(config, 'job-123');

  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [
    '--import',
    'tsx',
    path.join(root, 'src', 'server', 'cli.ts'),
    'internal-run',
    'job-123',
  ]);
});

test('buildInternalRunnerLaunchCommand falls back to the built cli when source is absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-launcher-dist-'));
  const config = createRuntimeConfig(root);
  const builtCliDir = path.join(root, 'dist', 'server', 'server');
  await mkdir(builtCliDir, { recursive: true });
  await writeFile(path.join(builtCliDir, 'cli.js'), 'console.log("ok");', 'utf8');

  const launch = await buildInternalRunnerLaunchCommand(config, 'job-789');

  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [
    path.join(root, 'dist', 'server', 'server', 'cli.js'),
    'internal-run',
    'job-789',
  ]);
});

test('launchDetachedJobRunner starts the built cli and captures launcher output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-launcher-built-'));
  const config = createRuntimeConfig(root);
  const builtCliDir = path.join(root, 'dist', 'server', 'server');
  const markerPath = path.join(root, 'detached-marker.txt');
  const launcherLogPath = path.join(config.artifactsDir, 'job-456', 'launcher.log');

  await mkdir(builtCliDir, { recursive: true });
  await mkdir(path.dirname(launcherLogPath), { recursive: true });
  await writeFile(path.join(builtCliDir, 'cli.js'), [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const markerPath = path.join(process.cwd(), "detached-marker.txt");',
    'fs.writeFileSync(markerPath, process.argv.slice(2).join(" "), "utf8");',
    'process.stdout.write(`launched ${process.argv.slice(2).join(" ")}\\n`);',
  ].join('\n'), 'utf8');

  await launchDetachedJobRunner(config, 'job-456');

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await pathExists(markerPath)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(await pathExists(markerPath), true);
  assert.equal(await readFile(markerPath, 'utf8'), 'internal-run job-456');
  assert.match(await readFile(launcherLogPath, 'utf8'), /launched internal-run job-456/);
});
