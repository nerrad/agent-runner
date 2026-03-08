import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from './fs-utils.js';

export type EnvValues = Record<string, string>;
export type EnvPatch = Record<string, string | undefined>;

const MANAGED_KEY_ORDER = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AGENT_RUNNER_HOME',
  'AGENT_RUNNER_GH_CONFIG',
  'AGENT_RUNNER_CLAUDE_DIR',
  'AGENT_RUNNER_CLAUDE_SETTINGS',
  'AGENT_RUNNER_CODEX_DIR',
  'AGENT_RUNNER_GITHUB_PROXY_URL',
  'AGENT_RUNNER_DOCKER_SOCKET',
  'AGENT_RUNNER_IMAGE',
] as const;

export async function loadProjectEnv(sourceRoot: string): Promise<string | null> {
  const envPath = path.join(sourceRoot, '.env');
  if (!(await pathExists(envPath))) {
    return null;
  }

  const values = await readEnvFile(envPath);
  for (const [ key, value ] of Object.entries(values)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  return envPath;
}

export async function readEnvFile(envPath: string): Promise<EnvValues> {
  if (!(await pathExists(envPath))) {
    return {};
  }

  const content = await readFile(envPath, 'utf8');
  return parseEnvFile(content);
}

export function parseEnvFile(content: string): EnvValues {
  const values: EnvValues = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const exportPrefix = line.startsWith('export ') ? 'export ' : '';
    const separator = line.indexOf('=', exportPrefix.length);
    if (separator === -1) {
      continue;
    }

    const key = line.slice(exportPrefix.length, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = line.slice(separator + 1).trim();
    values[key] = parseEnvValue(rawValue);
  }

  return values;
}

export async function updateEnvFile(envPath: string, patch: EnvPatch): Promise<EnvValues> {
  const nextValues = {
    ...await readEnvFile(envPath),
  };

  for (const [ key, value ] of Object.entries(patch)) {
    if (value === undefined) {
      delete nextValues[key];
      continue;
    }
    nextValues[key] = value;
  }

  const orderedKeys = [
    ...MANAGED_KEY_ORDER.filter((key) => key in nextValues),
    ...Object.keys(nextValues).filter((key) => !MANAGED_KEY_ORDER.includes(key as typeof MANAGED_KEY_ORDER[number])).sort(),
  ];

  const content = orderedKeys.map((key) => `${key}=${formatEnvValue(nextValues[key])}`).join('\n');
  await writeFile(envPath, content ? `${content}\n` : '', 'utf8');

  return nextValues;
}

function parseEnvValue(rawValue: string): string {
  if (!rawValue) {
    return '';
  }

  const quote = rawValue[0];
  if ((quote === '"' || quote === '\'') && rawValue.endsWith(quote)) {
    const inner = rawValue.slice(1, -1);
    if (quote === '"') {
      return inner
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return inner.replace(/\\'/g, '\'').replace(/\\\\/g, '\\');
  }

  const commentIndex = rawValue.search(/\s#/);
  if (commentIndex >= 0) {
    return rawValue.slice(0, commentIndex).trimEnd();
  }

  return rawValue;
}

function formatEnvValue(value: string): string {
  if (value === '') {
    return '""';
  }

  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}
