import type { AgentRuntime } from '../shared/types.js';

/**
 * Pattern-based fallback validators per runtime.
 *
 * These are intentionally broad enough to accept dated model snapshots
 * (e.g. claude-sonnet-4-6-20250514) and future minor variants, while
 * still rejecting obvious cross-runtime mistakes and garbage input.
 */
const CLAUDE_MODEL_PATTERN = /^(claude-|opus$|sonnet$|haiku$)/;
const CODEX_MODEL_PATTERN = /^(o[0-9]|gpt-|codex-|chatgpt-)/;

/**
 * Cross-runtime detection — catches the most common mistake of passing
 * an Anthropic model to the Codex runtime or vice-versa.
 */
const LOOKS_LIKE_CLAUDE = /^(claude-|opus$|sonnet$|haiku$)/;
const LOOKS_LIKE_OPENAI = /^(o[0-9]|gpt-|codex-|chatgpt-)/;

interface ModelListResponse {
  data?: Array<{ id: string }>;
}

const API_TIMEOUT_MS = 3_000;

async function fetchModelsFromApi(
  runtime: AgentRuntime,
): Promise<Set<string> | null> {
  try {
    if (runtime === 'claude') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return null;
      }
      const response = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as ModelListResponse;
      return extractModelIds(body);
    }

    // codex → OpenAI
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return null;
    }
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as ModelListResponse;
    return extractModelIds(body);
  } catch {
    return null;
  }
}

function extractModelIds(body: ModelListResponse): Set<string> | null {
  if (!body?.data || !Array.isArray(body.data)) {
    return null;
  }
  const ids = new Set<string>();
  for (const entry of body.data) {
    if (typeof entry.id === 'string') {
      ids.add(entry.id);
    }
  }
  return ids.size > 0 ? ids : null;
}

/**
 * Claude Code accepts short aliases (opus, sonnet, haiku) that don't
 * appear in the API's model list. Map them to a pattern that we can
 * check against the fetched IDs.
 */
const CLAUDE_ALIAS_PREFIXES: Record<string, string> = {
  opus: 'claude-opus-',
  sonnet: 'claude-sonnet-',
  haiku: 'claude-haiku-',
};

function aliasMatchesApiSet(model: string, apiModels: Set<string>): boolean {
  const prefix = CLAUDE_ALIAS_PREFIXES[model];
  if (!prefix) {
    return false;
  }
  for (const id of apiModels) {
    if (id.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function validateWithPattern(model: string, runtime: AgentRuntime): void {
  // Always reject cross-runtime first — this is the most helpful error.
  if (runtime === 'claude' && LOOKS_LIKE_OPENAI.test(model)) {
    throw new Error(
      `Model "${model}" looks like an OpenAI model but the runtime is "claude". Did you mean --runtime codex?`,
    );
  }
  if (runtime === 'codex' && LOOKS_LIKE_CLAUDE.test(model)) {
    throw new Error(
      `Model "${model}" looks like a Claude model but the runtime is "codex". Did you mean --runtime claude?`,
    );
  }

  const pattern = runtime === 'claude' ? CLAUDE_MODEL_PATTERN : CODEX_MODEL_PATTERN;
  if (!pattern.test(model)) {
    throw new Error(
      `Unrecognized model "${model}" for ${runtime} runtime. `
      + (runtime === 'claude'
        ? 'Expected a Claude model (e.g. sonnet, opus, haiku, claude-sonnet-4-6-20250514).'
        : 'Expected an OpenAI model (e.g. o3, gpt-4.1, codex-mini-latest).'),
    );
  }
}

// Per-process cache keyed by runtime — good enough for a short-lived CLI.
const apiCache = new Map<AgentRuntime, Set<string> | null>();

export async function validateModel(
  model: string,
  runtime: AgentRuntime,
): Promise<void> {
  // Try the API first (cached after the first call per runtime).
  if (!apiCache.has(runtime)) {
    apiCache.set(runtime, await fetchModelsFromApi(runtime));
  }
  const apiModels = apiCache.get(runtime)!;

  if (apiModels) {
    if (apiModels.has(model)) {
      return; // exact match in API — definitely valid
    }
    // Claude short aliases won't appear in the API list, check prefix match.
    if (runtime === 'claude' && aliasMatchesApiSet(model, apiModels)) {
      return;
    }
    // Model not in API list — reject with a clear message.
    throw new Error(
      `Model "${model}" is not available for the ${runtime} runtime. `
      + 'Run with a recognized model or omit --model to use the runtime default.',
    );
  }

  // API unavailable — fall back to pattern matching.
  validateWithPattern(model, runtime);
}

// Exposed for testing.
export { fetchModelsFromApi, validateWithPattern, apiCache };
