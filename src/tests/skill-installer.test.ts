import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import type { RuntimeConfig } from '../server/config.js';
import { resolveSourceRoot } from '../server/config.js';
import { installSkills } from '../server/skill-installer.js';

function createConfig(root: string): RuntimeConfig {
  return {
    appDir: root,
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
    sourceRoot: path.resolve(new URL('../..', import.meta.url).pathname),
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
    uiSessionToken: 'session-token',
  };
}

test('installSkills copies the canonical skill into selected target roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-skills-'));
  const config = createConfig(root);

  const installed = await installSkills(
    config,
    (target) => path.join(root, target),
    { targets: [ 'claude', 'codex' ] },
  );

  assert.equal(installed.length, 2);
  assert.match(await readFile(path.join(root, 'claude', 'launch-agent-runner-spec', 'SKILL.md'), 'utf8'), /existing spec/);
  assert.match(await readFile(path.join(root, 'codex', 'launch-agent-runner-spec', 'agents', 'openai.yaml'), 'utf8'), /display_name/);
});

test('installSkills refuses to overwrite an existing install without force', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-skills-force-'));
  const config = createConfig(root);

  await installSkills(config, (target) => path.join(root, target), { targets: [ 'claude' ] });

  await assert.rejects(
    () => installSkills(config, (target) => path.join(root, target), { targets: [ 'claude' ] }),
    /--force/,
  );
});

test('installSkills succeeds when sourceRoot is resolved from a built module path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-runner-skills-dist-root-'));
  const resolvedSourceRoot = await resolveSourceRoot(new URL('../../dist/server/server/config.js', import.meta.url).href);
  const config = {
    ...createConfig(root),
    sourceRoot: resolvedSourceRoot,
  };

  const installed = await installSkills(config, (target) => path.join(root, target), { targets: [ 'claude' ] });

  assert.equal(installed.length, 1);
  assert.match(await readFile(path.join(root, 'claude', 'launch-agent-runner-spec', 'SKILL.md'), 'utf8'), /existing spec/);
});
