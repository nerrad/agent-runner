import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModel, validateWithPattern, fetchModelsFromApi, apiCache } from '../server/model-validator.js';

// ---------------------------------------------------------------------------
// Pattern-based validation (synchronous, no API)
// ---------------------------------------------------------------------------

test('validateWithPattern accepts valid Claude models', () => {
  for (const model of [
    'opus', 'sonnet', 'haiku',
    'claude-opus-4-6-20250514',
    'claude-sonnet-4-6-20250514',
    'claude-sonnet-4-5-20250514',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
  ]) {
    assert.doesNotThrow(() => validateWithPattern(model, 'claude'), `should accept "${model}"`);
  }
});

test('validateWithPattern accepts valid Codex models', () => {
  for (const model of [
    'o3', 'o3-mini', 'o4-mini', 'o1', 'o1-mini', 'o1-pro',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4o', 'gpt-4o-mini',
    'codex-mini-latest',
  ]) {
    assert.doesNotThrow(() => validateWithPattern(model, 'codex'), `should accept "${model}"`);
  }
});

test('validateWithPattern rejects cross-runtime models', () => {
  assert.throws(
    () => validateWithPattern('sonnet', 'codex'),
    /looks like a Claude model.*--runtime claude/,
  );
  assert.throws(
    () => validateWithPattern('claude-sonnet-4-6-20250514', 'codex'),
    /looks like a Claude model/,
  );
  assert.throws(
    () => validateWithPattern('gpt-4.1', 'claude'),
    /looks like an OpenAI model.*--runtime codex/,
  );
  assert.throws(
    () => validateWithPattern('o3', 'claude'),
    /looks like an OpenAI model/,
  );
});

test('validateWithPattern rejects unrecognized models', () => {
  assert.throws(
    () => validateWithPattern('llama-3', 'claude'),
    /Unrecognized model "llama-3"/,
  );
  assert.throws(
    () => validateWithPattern('llama-3', 'codex'),
    /Unrecognized model "llama-3"/,
  );
  assert.throws(
    () => validateWithPattern('sonnett', 'claude'),
    /Unrecognized model "sonnett"/,
  );
});

// ---------------------------------------------------------------------------
// API-based validation (with mocked fetch)
// ---------------------------------------------------------------------------

test('validateModel accepts model found in API response', async () => {
  apiCache.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: 'claude-sonnet-4-6-20250514' },
      { id: 'claude-opus-4-6-20250514' },
    ],
  }), { status: 200 });

  try {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await assert.doesNotReject(validateModel('claude-sonnet-4-6-20250514', 'claude'));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = originalFetch;
    apiCache.clear();
  }
});

test('validateModel accepts Claude short alias when prefix matches API models', async () => {
  apiCache.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: 'claude-sonnet-4-6-20250514' },
      { id: 'claude-opus-4-6-20250514' },
    ],
  }), { status: 200 });

  try {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await assert.doesNotReject(validateModel('sonnet', 'claude'));
    await assert.doesNotReject(validateModel('opus', 'claude'));
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = originalFetch;
    apiCache.clear();
  }
});

test('validateModel rejects model not in API response', async () => {
  apiCache.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: 'claude-sonnet-4-6-20250514' },
    ],
  }), { status: 200 });

  try {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await assert.rejects(
      validateModel('claude-nonexistent-99', 'claude'),
      /not available for the claude runtime/,
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = originalFetch;
    apiCache.clear();
  }
});

test('validateModel falls back to pattern validation when API fails', async () => {
  apiCache.clear();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 500 });

  try {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Valid pattern — should pass
    await assert.doesNotReject(validateModel('sonnet', 'claude'));
    // Invalid pattern — should fail
    await assert.rejects(
      validateModel('llama-3', 'claude'),
      /Unrecognized model "llama-3"/,
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = originalFetch;
    apiCache.clear();
  }
});

test('validateModel falls back to pattern validation when API key is missing', async () => {
  apiCache.clear();
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('', { status: 500 });
  };

  try {
    delete process.env.ANTHROPIC_API_KEY;
    await assert.doesNotReject(validateModel('sonnet', 'claude'));
    assert.equal(fetchCalled, false, 'should not call fetch without API key');
  } finally {
    globalThis.fetch = originalFetch;
    apiCache.clear();
  }
});

test('validateModel caches API result across calls', async () => {
  apiCache.clear();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount++;
    return new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-6-20250514' }],
    }), { status: 200 });
  };

  try {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await validateModel('claude-sonnet-4-6-20250514', 'claude');
    await validateModel('claude-sonnet-4-6-20250514', 'claude');
    assert.equal(fetchCount, 1, 'should only fetch once per runtime');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = originalFetch;
    apiCache.clear();
  }
});

test('fetchModelsFromApi returns null without API key', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await fetchModelsFromApi('claude');
    assert.equal(result, null);
  } finally {
    if (saved) {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  }
});
