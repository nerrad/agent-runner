import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { RuntimeConfig } from './config.js';
import { ensureDir } from './fs-utils.js';

export interface McpServerManifestEntry {
  name: string;
  source: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  brokerUrl: string;
}

export interface McpRewriteFileOverlay {
  hostStagingPath: string;
  containerTargetPath: string;
}

export interface McpRewriteResult {
  manifest: McpServerManifestEntry[];
  overlays: McpRewriteFileOverlay[];
  skipped: string[];
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  [key: string]: unknown;
}

interface McpJsonFile {
  mcpServers?: Record<string, McpServerEntry>;
}

export async function rewriteMcpConfigs(
  config: RuntimeConfig,
  stagingDir: string,
  jobId: string,
  brokerBaseUrl: string,
  brokerToken: string,
): Promise<McpRewriteResult> {
  const manifest: McpServerManifestEntry[] = [];
  const overlays: McpRewriteFileOverlay[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const containerHome = '/home/agent-runner';

  await rewriteClaudePlugins(config, stagingDir, jobId, brokerBaseUrl, brokerToken, containerHome, manifest, overlays, skipped, seen);
  await rewriteCodexConfig(config, stagingDir, jobId, brokerBaseUrl, brokerToken, containerHome, manifest, overlays, skipped, seen);

  return { manifest, overlays, skipped };
}

async function rewriteClaudePlugins(
  config: RuntimeConfig,
  stagingDir: string,
  jobId: string,
  brokerBaseUrl: string,
  brokerToken: string,
  containerHome: string,
  manifest: McpServerManifestEntry[],
  overlays: McpRewriteFileOverlay[],
  skipped: string[],
  seen: Set<string>,
): Promise<void> {
  const pluginCacheDir = path.join(config.claudeDir, 'plugins', 'cache');

  let mcpFiles: string[];
  try {
    mcpFiles = await findMcpJsonFiles(pluginCacheDir);
  } catch {
    return;
  }

  for (const filePath of mcpFiles) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    let parsed: McpJsonFile;
    try {
      parsed = JSON.parse(content) as McpJsonFile;
    } catch {
      continue;
    }

    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      continue;
    }

    let hasCommandBased = false;
    const rewritten: McpJsonFile = { mcpServers: {} };

    for (const [name, entry] of Object.entries(parsed.mcpServers)) {
      if (entry.command && !entry.url) {
        hasCommandBased = true;
        const brokerUrl = buildBrokerSseUrl(brokerBaseUrl, jobId, name, brokerToken);
        rewritten.mcpServers![name] = { type: 'sse', url: brokerUrl };

        const dedupeKey = `${name}:${entry.command}:${JSON.stringify(entry.args ?? [])}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          const relativePath = path.relative(pluginCacheDir, filePath);
          const pathParts = relativePath.split(path.sep);
          const source = `claude-plugin:${pathParts.length >= 2 ? pathParts.slice(0, -1).join('/') : relativePath}`;
          manifest.push({
            name,
            source,
            command: entry.command,
            args: entry.args ?? [],
            env: extractStringEnv(entry.env),
            brokerUrl,
          });
        }
      } else {
        rewritten.mcpServers![name] = entry;
        if (entry.url || entry.type === 'http' || entry.type === 'sse') {
          skipped.push(name);
        }
      }
    }

    if (!hasCommandBased) {
      continue;
    }

    const relativePath = path.relative(config.claudeDir, filePath);
    const stagingPath = path.join(stagingDir, 'claude', relativePath);
    await ensureDir(path.dirname(stagingPath));
    await writeFile(stagingPath, JSON.stringify(rewritten, null, 2), 'utf8');

    overlays.push({
      hostStagingPath: stagingPath,
      containerTargetPath: path.join(containerHome, '.claude', relativePath),
    });
  }
}

async function rewriteCodexConfig(
  config: RuntimeConfig,
  stagingDir: string,
  jobId: string,
  brokerBaseUrl: string,
  brokerToken: string,
  containerHome: string,
  manifest: McpServerManifestEntry[],
  overlays: McpRewriteFileOverlay[],
  skipped: string[],
  seen: Set<string>,
): Promise<void> {
  const configPath = path.join(config.codexDir, 'config.toml');

  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(content);
  } catch {
    return;
  }

  const mcpServers = parsed.mcp_servers as Record<string, Record<string, unknown>> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return;
  }

  let hasCommandBased = false;
  const rewrittenServers: Record<string, Record<string, unknown>> = {};

  for (const [name, entry] of Object.entries(mcpServers)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    if (entry.command && !entry.url) {
      hasCommandBased = true;
      const brokerUrl = buildBrokerSseUrl(brokerBaseUrl, jobId, name, brokerToken);
      rewrittenServers[name] = { url: brokerUrl };

      const dedupeKey = `${name}:${entry.command}:${JSON.stringify(entry.args ?? [])}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        manifest.push({
          name,
          source: 'codex-config',
          command: String(entry.command),
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          env: extractStringEnv(entry.env as Record<string, unknown> | undefined),
          brokerUrl,
        });
      }
    } else {
      rewrittenServers[name] = entry;
      if (entry.url) {
        skipped.push(name);
      }
    }
  }

  if (!hasCommandBased) {
    return;
  }

  const rewrittenDoc = { ...parsed, mcp_servers: rewrittenServers };
  const stagingPath = path.join(stagingDir, 'codex', 'config.toml');
  await ensureDir(path.dirname(stagingPath));
  await writeFile(stagingPath, stringifyToml(rewrittenDoc), 'utf8');

  overlays.push({
    hostStagingPath: stagingPath,
    containerTargetPath: path.join(containerHome, '.codex', 'config.toml'),
  });
}

async function findMcpJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findMcpJsonFiles(fullPath);
      results.push(...nested);
    } else if (entry.name === '.mcp.json') {
      results.push(fullPath);
    }
  }
  return results;
}

function buildBrokerSseUrl(brokerBaseUrl: string, jobId: string, serverName: string, token: string): string {
  return `${brokerBaseUrl}/broker/jobs/${jobId}/mcp/${encodeURIComponent(serverName)}/sse?token=${encodeURIComponent(token)}`;
}

function extractStringEnv(env: Record<string, unknown> | undefined): Record<string, string> {
  if (!env || typeof env !== 'object') {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}
