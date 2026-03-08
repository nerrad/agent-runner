import readline from 'node:readline';
import path from 'node:path';
import process from 'node:process';
import type { RuntimeConfig } from './config.js';
import { readEnvFile, updateEnvFile } from './env-file.js';

const AUTH_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

type AuthKey = typeof AUTH_KEYS[number];
type PromptSecret = (key: AuthKey, hasExistingValue: boolean) => Promise<string>;

export interface InitResult {
  envPath: string;
  savedKeys: AuthKey[];
}

export async function runInit(
  config: RuntimeConfig,
  promptSecret: PromptSecret = promptForSecret,
): Promise<InitResult> {
  const envPath = path.join(config.sourceRoot, '.env');
  const existingValues = await readEnvFile(envPath);
  const patch: Record<string, string | undefined> = {};

  for (const key of AUTH_KEYS) {
    const answer = await promptSecret(key, key in existingValues);
    if (!answer) {
      continue;
    }
    if (answer === '-') {
      patch[key] = undefined;
      continue;
    }
    patch[key] = answer;
  }

  const savedValues = await updateEnvFile(envPath, patch);
  return {
    envPath,
    savedKeys: AUTH_KEYS.filter((key) => key in savedValues),
  };
}

async function promptForSecret(key: AuthKey, hasExistingValue: boolean): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('agent-runner init requires an interactive terminal');
  }

  const hint = hasExistingValue ? 'leave blank to keep current value, "-" to clear' : 'leave blank to skip';
  process.stdout.write(`${key} (${hint}): `);
  return await readHiddenInput();
}

async function readHiddenInput(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output, terminal: true });
    const previousRawMode = input.isTTY ? input.isRaw : false;
    let value = '';

    const cleanup = (): void => {
      input.removeListener('keypress', onKeypress);
      if (input.isTTY) {
        input.setRawMode(previousRawMode);
      }
      rl.close();
    };

    const onKeypress = (_str: string, key: readline.Key): void => {
      if (key.name === 'return' || key.name === 'enter') {
        output.write('\n');
        cleanup();
        resolve(value);
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        if (value.length > 0) {
          value = value.slice(0, -1);
        }
        return;
      }

      if (key.ctrl && key.name === 'c') {
        output.write('\n');
        cleanup();
        reject(new Error('Initialization canceled'));
        return;
      }

      if (key.sequence) {
        value += key.sequence;
      }
    };

    readline.emitKeypressEvents(input, rl);
    if (input.isTTY) {
      input.setRawMode(true);
    }
    input.on('keypress', onKeypress);
  });
}
