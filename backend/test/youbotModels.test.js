const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

const segmented = [{ text: 'RULES ', cache: true }, { text: 'JOB ', cache: true }, { text: 'PROFILE' }];
const request = { prompt: segmented, maxTokens: 500, temperature: 0.2, responseFormat: 'json' };
// What every family sends: a stateless one-shot prompt, never streamed.
const COMMON = { memory: false, stream: false };

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

test('you.bot model families are matched by id prefix, with a generic fallback', () => {
  const { resolveYoubotModelFamily } = loadFresh('../dist/providers/adapters/youbotModels');
  assert.equal(resolveYoubotModelFamily('claude-haiku-4-5').name, 'claude');
  assert.equal(resolveYoubotModelFamily('claude-sonnet-5').name, 'claude');
  assert.equal(resolveYoubotModelFamily('gpt-5-6-luna').name, 'gpt');
  assert.equal(resolveYoubotModelFamily('gemini-3-7-flash').name, 'gemini');
  assert.equal(resolveYoubotModelFamily('gemini-3-8-flash').name, 'gemini');
  assert.equal(resolveYoubotModelFamily('grok-4-6').name, 'generic', 'an unlisted vendor still gets the documented common shape');
});

test('each you.bot family gets the input shape its vendor accepts', () => {
  const { buildYoubotInput, resolveYoubotModelFamily } = loadFresh('../dist/providers/adapters/youbotModels');
  delete process.env.YOUBOT_REASONING_EFFORT;
  const input = (modelId, options = { promptCache: true }, req = request) =>
    buildYoubotInput(req, resolveYoubotModelFamily(modelId), options);

  // Claude: content blocks with cache_control on the stable prefix, an enforced token
  // limit, temperature, thinking off, web search off.
  assert.deepEqual(input('claude-haiku-4-5'), {
    ...COMMON,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'RULES ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'JOB ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'PROFILE' },
      ],
    }],
    max_tokens: 500,
    temperature: 0.2,
    thinking: false,
    web_search: false,
  });

  // GPT: flat text (non-Claude models ignore cache markers), a reasoning level instead of a
  // thinking switch, no temperature (reasoning models refuse one), no max_tokens (not
  // applied), and no web_search field at all — Luna rejects it whether true or false.
  assert.deepEqual(input('gpt-5-6-luna'), { ...COMMON, prompt: 'RULES JOB PROFILE', reasoning_effort: 'Low' });

  // Gemini: flat text, temperature, thinking off plus a reasoning level (the switch alone
  // is not honoured), web search off, and no max_tokens because you.bot ignores it there.
  assert.deepEqual(input('gemini-3-8-flash'), {
    ...COMMON,
    prompt: 'RULES JOB PROFILE',
    temperature: 0.2,
    thinking: false,
    web_search: false,
    reasoning_effort: 'Low',
  });

  // Unknown vendor: only the fields every chat model documents.
  assert.deepEqual(input('grok-4-6'), { ...COMMON, prompt: 'RULES JOB PROFILE', temperature: 0.2 });

  // Caching switched off: Claude gets flat text too; a plain-string prompt never becomes blocks.
  assert.equal(input('claude-haiku-4-5', { promptCache: false }).prompt, 'RULES JOB PROFILE');
  assert.equal(input('claude-haiku-4-5', { promptCache: true }, { ...request, prompt: 'Say pong' }).prompt, 'Say pong');
});

test('reasoning effort comes from YOUBOT_REASONING_EFFORT in any casing, else Low', (t) => {
  const { resolveReasoningEffort, buildYoubotInput, resolveYoubotModelFamily } = loadFresh('../dist/providers/adapters/youbotModels');
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));

  assert.equal(resolveReasoningEffort(undefined), 'Low');
  assert.equal(resolveReasoningEffort('  '), 'Low');
  assert.equal(resolveReasoningEffort('high'), 'High');
  assert.equal(resolveReasoningEffort('XHIGH'), 'XHigh');
  assert.equal(resolveReasoningEffort('ultra'), 'Low');
  assert.equal(resolveReasoningEffort('ultra'), 'Low');
  assert.equal(warnings.length, 1, 'an unusable value is reported once, not on every call');
  assert.match(warnings[0], /YOUBOT_REASONING_EFFORT="ultra" is not one of Low, Medium, High, XHigh; using Low/);

  process.env.YOUBOT_REASONING_EFFORT = 'medium';
  const luna = buildYoubotInput(request, resolveYoubotModelFamily('gpt-5-6-luna'), { promptCache: true });
  assert.equal(luna.reasoning_effort, 'Medium');
  delete process.env.YOUBOT_REASONING_EFFORT;
});

test('you.bot adapter sends a GPT model flat text and polls the task under its own id', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  t.mock.method(console, 'log', () => {});
  delete process.env.YOUBOT_PROMPT_CACHE;
  delete process.env.YOUBOT_REASONING_EFFORT;

  const calls = [];
  const replies = [
    { taskId: 'g1' },
    { taskId: 'g1', status: 'completed', text: '{"title":"ok"}', usage: { inputTokens: 1300, outputTokens: 5 }, creditsCharged: 0.11 },
  ];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url, init });
    return jsonResponse(replies.shift());
  });

  const adapter = createYoubotAdapter({ baseUrl: 'https://example.test/api/v1', sleep: async () => {}, pollIntervalMs: 1 });
  const context = { providerId: 'youbot', apiKey: 'sk-test', model: 'gpt-5-6-luna' };
  assert.equal(await adapter.complete(request, context), '{"title":"ok"}');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.modelId, 'gpt-5-6-luna');
  assert.deepEqual(body.input, { ...COMMON, prompt: 'RULES JOB PROFILE', reasoning_effort: 'Low' });
  assert.equal(calls[1].url, 'https://example.test/api/v1/task/g1?model=gpt-5-6-luna');
});

test('you.bot adapter never judges a Gemini reply cut off by a limit it did not send', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  t.mock.method(console, 'log', () => {});
  const adapter = createYoubotAdapter({ baseUrl: 'https://example.test/api/v1', sleep: async () => {} });

  // Seen live: a 200-word essay billed 5,101 output tokens (hidden thinking included)
  // against a requested limit of 100. For Claude the same figures mean a truncated reply.
  const reply = { taskId: 'x', text: '{"title":"ok"}', usage: { inputTokens: 65, outputTokens: 5101 }, creditsCharged: 0.83 };
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(reply));

  const gemini = { providerId: 'youbot', apiKey: 'sk-test', model: 'gemini-3-7-flash' };
  assert.equal(await adapter.complete({ ...request, maxTokens: 100 }, gemini), '{"title":"ok"}');

  const claude = { providerId: 'youbot', apiKey: 'sk-test', model: 'claude-haiku-4-5' };
  await assert.rejects(() => adapter.complete({ ...request, maxTokens: 100 }, claude), /cut off at the 100-token output limit/);
});
