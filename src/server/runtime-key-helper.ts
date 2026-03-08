import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRuntime } from '../shared/types.js';
import type { RuntimeConfig } from './config.js';
import { loadRuntimeConfig } from './config.js';
import { readJsonFile } from './fs-utils.js';
import { runCommand } from './process-utils.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const CLAUDE_KEYCHAIN_SERVICES = [
  'anthropic-api-key',
  'Anthropic API Key',
  'claude-code-api-key',
  'Claude Code API Key',
  'claude-code',
  'Claude Code',
] as const;

const OPENAI_KEYCHAIN_SERVICES = [
  'openai-api-key',
  'OpenAI API Key',
  'codex-openai-api-key',
  'Codex OpenAI API Key',
  'codex',
  'Codex',
] as const;

export async function resolveDefaultRuntimeApiKey(
  runtime: AgentRuntime,
  config: RuntimeConfig,
): Promise<string | null> {
  if (runtime === 'claude') {
    return await resolveClaudeApiKey(config);
  }

  return await resolveCodexApiKey(config);
}

async function resolveClaudeApiKey(config: RuntimeConfig): Promise<string | null> {
  const configuredHelper = await findConfiguredHelperCommand([
    path.join(config.claudeDir, 'settings.json'),
    config.claudeSettingsPath,
  ]);
  const helperValue = configuredHelper ? await runHelperCommand(configuredHelper) : null;
  if (helperValue) {
    return helperValue;
  }

  const configuredApiKey = await findConfiguredApiKey([
    path.join(config.claudeDir, 'settings.json'),
    config.claudeSettingsPath,
  ]);
  if (configuredApiKey) {
    return configuredApiKey;
  }

  return await resolveMacOsKeychainSecret(CLAUDE_KEYCHAIN_SERVICES);
}

async function resolveCodexApiKey(config: RuntimeConfig): Promise<string | null> {
  const authFile = path.join(config.codexDir, 'auth.json');
  const auth = await readJson(authFile);
  const fileKey = findFirstString(auth, [ 'OPENAI_API_KEY', 'openaiApiKey', 'apiKey' ]);
  if (fileKey) {
    return fileKey;
  }

  return await resolveMacOsKeychainSecret(OPENAI_KEYCHAIN_SERVICES);
}

async function findConfiguredHelperCommand(candidatePaths: string[]): Promise<string | null> {
  for (const candidatePath of candidatePaths) {
    const parsed = await readJson(candidatePath);
    const helperCommand = findFirstString(parsed, [ 'apiKeyHelper' ]);
    if (helperCommand) {
      return helperCommand;
    }
  }

  return null;
}

async function findConfiguredApiKey(candidatePaths: string[]): Promise<string | null> {
  for (const candidatePath of candidatePaths) {
    const parsed = await readJson(candidatePath);
    const apiKey = findFirstString(parsed, [ 'apiKey', 'ANTHROPIC_API_KEY' ]);
    if (apiKey) {
      return apiKey;
    }
  }

  return null;
}

async function readJson(targetPath: string): Promise<JsonValue | null> {
  try {
    return await readJsonFile<JsonValue>(targetPath);
  } catch {
    return null;
  }
}

function findFirstString(value: JsonValue, targetKeys: string[]): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstString(item, targetKeys);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const [ key, nestedValue ] of Object.entries(value)) {
    if (targetKeys.includes(key) && typeof nestedValue === 'string' && nestedValue.trim()) {
      return nestedValue.trim();
    }
  }

  for (const nestedValue of Object.values(value)) {
    const nested = findFirstString(nestedValue, targetKeys);
    if (nested) {
      return nested;
    }
  }

  return null;
}

async function runHelperCommand(helperCommand: string): Promise<string | null> {
  const result = await runCommand('/bin/sh', [ '-lc', helperCommand ], {
    env: process.env,
  });
  const value = result.stdout.trim();
  if (result.exitCode === 0 && value) {
    return value;
  }

  return null;
}

async function resolveMacOsKeychainSecret(serviceCandidates: readonly string[]): Promise<string | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  const accountCandidates = new Set<string>();
  if (process.env.USER?.trim()) {
    accountCandidates.add(process.env.USER.trim());
  }

  try {
    const userInfoName = os.userInfo().username.trim();
    if (userInfoName) {
      accountCandidates.add(userInfoName);
    }
  } catch {}

  for (const service of serviceCandidates) {
    for (const account of accountCandidates) {
      const withAccount = await runCommand('security', [
        'find-generic-password',
        '-a',
        account,
        '-s',
        service,
        '-w',
      ], {
        env: process.env,
      });
      const accountValue = withAccount.stdout.trim();
      if (withAccount.exitCode === 0 && accountValue) {
        return accountValue;
      }
    }

    const withoutAccount = await runCommand('security', [
      'find-generic-password',
      '-s',
      service,
      '-w',
    ], {
      env: process.env,
    });
    const serviceValue = withoutAccount.stdout.trim();
    if (withoutAccount.exitCode === 0 && serviceValue) {
      return serviceValue;
    }
  }

  return null;
}

async function main(): Promise<void> {
  const runtime = process.argv[2];
  if (runtime !== 'claude' && runtime !== 'codex') {
    process.stderr.write('Usage: runtime-key-helper <claude|codex>\n');
    process.exitCode = 1;
    return;
  }

  const config = await loadRuntimeConfig();
  const key = await resolveDefaultRuntimeApiKey(runtime, config);
  if (!key) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write(key);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
