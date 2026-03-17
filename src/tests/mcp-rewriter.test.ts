import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { rewriteMcpConfigs } from '../server/mcp-rewriter.js';
import type { RuntimeConfig } from '../server/config.js';

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
    workerImageTag: 'agent-runner-worker:latest',
    sourceRoot: root,
    brokerPort: 4318,
    brokerHost: 'host.docker.internal',
    brokerUrl: 'http://host.docker.internal:4318',
  };
}

test('rewriteMcpConfigs rewrites command-based Claude plugin .mcp.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  const pluginDir = path.join(config.claudeDir, 'plugins', 'cache', 'my-org', 'my-plugin', '1.0.0');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'my-server': {
        command: 'npx',
        args: ['-y', '@my-org/mcp-server'],
        env: { API_KEY: 'secret123' },
      },
    },
  }));

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-1', 'http://host:4318', 'tok-abc');

  assert.equal(result.manifest.length, 1);
  assert.equal(result.manifest[0].name, 'my-server');
  assert.equal(result.manifest[0].command, 'npx');
  assert.deepEqual(result.manifest[0].args, ['-y', '@my-org/mcp-server']);
  assert.deepEqual(result.manifest[0].env, { API_KEY: 'secret123' });
  assert.match(result.manifest[0].brokerUrl, /\/broker\/jobs\/job-1\/mcp\/my-server\/sse\?token=tok-abc/);

  assert.equal(result.overlays.length, 1);
  assert.match(result.overlays[0].containerTargetPath, /\/home\/agent-runner\/.claude\/plugins\/cache/);

  const rewrittenContent = await readFile(result.overlays[0].hostStagingPath, 'utf8');
  const rewritten = JSON.parse(rewrittenContent);
  assert.equal(rewritten.mcpServers['my-server'].type, 'sse');
  assert.match(rewritten.mcpServers['my-server'].url, /\/broker\/jobs\/job-1\/mcp\/my-server\/sse/);
  assert.equal(rewritten.mcpServers['my-server'].command, undefined);
});

test('rewriteMcpConfigs skips URL-based Claude plugin servers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-skip-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  const pluginDir = path.join(config.claudeDir, 'plugins', 'cache', 'official', 'Notion', '0.1.0');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      notion: {
        type: 'http',
        url: 'https://mcp.notion.com/mcp',
      },
    },
  }));

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-2', 'http://host:4318', 'tok-abc');

  assert.equal(result.manifest.length, 0);
  assert.equal(result.overlays.length, 0);
  assert.ok(result.skipped.includes('notion'));
});

test('rewriteMcpConfigs handles mixed command and URL-based servers in one file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-mixed-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  const pluginDir = path.join(config.claudeDir, 'plugins', 'cache', 'mixed', 'plugin', '1.0.0');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'cmd-server': {
        command: 'node',
        args: ['server.js'],
      },
      'url-server': {
        type: 'http',
        url: 'https://example.com/mcp',
      },
    },
  }));

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-3', 'http://host:4318', 'tok-abc');

  assert.equal(result.manifest.length, 1);
  assert.equal(result.manifest[0].name, 'cmd-server');
  assert.equal(result.overlays.length, 1);
  assert.ok(result.skipped.includes('url-server'));

  const rewrittenContent = await readFile(result.overlays[0].hostStagingPath, 'utf8');
  const rewritten = JSON.parse(rewrittenContent);
  assert.equal(rewritten.mcpServers['cmd-server'].type, 'sse');
  assert.equal(rewritten.mcpServers['url-server'].type, 'http');
  assert.equal(rewritten.mcpServers['url-server'].url, 'https://example.com/mcp');
});

test('rewriteMcpConfigs rewrites command-based codex config.toml servers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-codex-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  await mkdir(config.codexDir, { recursive: true });
  await writeFile(path.join(config.codexDir, 'config.toml'), `
model = "gpt-5"

[mcp_servers.playwright]
command = "pnpm"
args = ["dlx", "@playwright/mcp@latest"]

[mcp_servers.playwright.env]
TOKEN = "secret"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`);

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-4', 'http://host:4318', 'tok-abc');

  assert.equal(result.manifest.length, 1);
  assert.equal(result.manifest[0].name, 'playwright');
  assert.equal(result.manifest[0].command, 'pnpm');
  assert.deepEqual(result.manifest[0].args, ['dlx', '@playwright/mcp@latest']);
  assert.deepEqual(result.manifest[0].env, { TOKEN: 'secret' });

  assert.equal(result.overlays.length, 1);
  assert.equal(result.overlays[0].containerTargetPath, '/home/agent-runner/.codex/config.toml');

  const rewrittenContent = await readFile(result.overlays[0].hostStagingPath, 'utf8');
  assert.match(rewrittenContent, /url = /);
  assert.ok(!rewrittenContent.includes('command = "pnpm"'));
  assert.ok(result.skipped.includes('linear'));
});

test('rewriteMcpConfigs returns empty result when no configs exist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-empty-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-5', 'http://host:4318', 'tok-abc');

  assert.equal(result.manifest.length, 0);
  assert.equal(result.overlays.length, 0);
  assert.equal(result.skipped.length, 0);
});

test('rewriteMcpConfigs deduplicates manifest entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-dedup-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  // Create two plugin dirs with the same server definition
  for (const version of ['1.0.0', '1.1.0']) {
    const pluginDir = path.join(config.claudeDir, 'plugins', 'cache', 'org', 'plugin', version);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'my-server': {
          command: 'npx',
          args: ['-y', 'my-server'],
        },
      },
    }));
  }

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-6', 'http://host:4318', 'tok-abc');

  // Both files get overlays, but manifest should deduplicate
  assert.equal(result.manifest.length, 1);
  assert.equal(result.overlays.length, 2);
});

test('rewriteMcpConfigs URL-encodes server name and token in broker URLs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-rewriter-encode-'));
  const config = createConfig(root);
  const stagingDir = path.join(root, 'staging');

  const pluginDir = path.join(config.claudeDir, 'plugins', 'cache', 'org', 'plugin', '1.0.0');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'server with spaces': {
        command: 'node',
        args: ['run.js'],
      },
    },
  }));

  const result = await rewriteMcpConfigs(config, stagingDir, 'job-7', 'http://host:4318', 'tok&special=true');

  assert.equal(result.manifest.length, 1);
  assert.match(result.manifest[0].brokerUrl, /server%20with%20spaces/);
  assert.match(result.manifest[0].brokerUrl, /tok%26special%3Dtrue/);
});
