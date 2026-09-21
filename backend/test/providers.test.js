const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, makeTempDataDir } = require('./helpers');

const noSleep = async () => {};
// These tests exercise the adapters' own retries; the dispatcher's transient-retry budget
// would turn a deliberately failing mock into a ten-minute wait.
process.env.AI_RETRY_BUDGET_MS = '0';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const youbotContext = { providerId: 'youbot', apiKey: 'sk-test', model: 'claude-sonnet-5' };
const request = { prompt: 'Say pong', maxTokens: 16, temperature: 0, responseFormat: 'text' };
const baseUrl = 'https://example.test/api/v1';

test('registry resolves provider ids, model prefixes, and environment overrides', () => {
  const registry = loadFresh('../dist/providers/registry');

  assert.deepEqual(registry.PROVIDER_IDS, ['openai', 'claude', 'openrouter', 'youbot', 'cheapai']);
  assert.equal(registry.DEFAULT_PROVIDER_ID, 'openai');
  assert.equal(registry.isProviderId('youbot'), true);
  assert.equal(registry.isProviderId('bing'), false);

  assert.equal(registry.resolveProviderId('youbot'), 'youbot');
  assert.equal(registry.resolveProviderId('gpt-4o-mini'), 'openai');
  assert.equal(registry.resolveProviderId('claude-3-opus'), 'claude');
  assert.equal(registry.resolveProviderId('openrouter/anything'), 'openrouter');
  assert.equal(registry.resolveProviderId('nope'), 'openai');
  assert.equal(registry.resolveProviderId(undefined), 'openai');

  process.env.YOUBOT_MODEL = '';
  assert.equal(registry.getProviderModel('youbot'), 'claude-sonnet-5');
  process.env.YOUBOT_MODEL = 'gpt-image-2-text-to-image';
  assert.equal(registry.getProviderModel('youbot'), 'gpt-image-2-text-to-image');
  process.env.YOUBOT_MODEL = '';

  assert.deepEqual(registry.getProviderModels('youbot'), ['claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5-6-luna', 'gemini-3-7-flash', 'gemini-3-8-flash', 'gemini-3-flash']);
  process.env.YOUBOT_MODEL = ' claude-haiku-4-5 , claude-sonnet-5,, claude-haiku-4-5 ';
  assert.deepEqual(registry.getProviderModels('youbot'), ['claude-haiku-4-5', 'claude-sonnet-5'], 'trimmed, blanks dropped, duplicates collapsed');
  assert.equal(registry.getProviderModel('youbot'), 'claude-haiku-4-5', 'the first listed model is the default');
  assert.deepEqual(registry.resolveModelSelection('youbot'), { providerId: 'youbot', model: 'claude-haiku-4-5' });
  assert.deepEqual(registry.resolveModelSelection('youbot/claude-sonnet-5'), { providerId: 'youbot', model: 'claude-sonnet-5' });
  assert.deepEqual(registry.resolveModelSelection(undefined), { providerId: 'openai', model: registry.getProviderModel('openai') });
  assert.equal(registry.resolveModelSelection('claude-3-opus').providerId, 'claude', 'a raw model string still maps to its provider');
  assert.throws(
    () => registry.resolveModelSelection('youbot/claude-opus-5'),
    /you\.bot does not offer the model "claude-opus-5"; available: claude-haiku-4-5, claude-sonnet-5/
  );
  assert.deepEqual(registry.toModelSelection('youbot'), { providerId: 'youbot', model: 'claude-haiku-4-5' });
  process.env.YOUBOT_MODEL = '';

  process.env.YOUBOT_API_KEY = '  env-key  ';
  assert.equal(registry.getProviderEnvironmentApiKey('youbot'), 'env-key');
  process.env.YOUBOT_API_KEY = '';
  assert.equal(registry.getProviderEnvironmentApiKey('youbot'), '');

  assert.deepEqual(registry.buildProviderRecord((definition) => definition.label), {
    openai: 'OpenAI',
    claude: 'Claude',
    openrouter: 'OpenRouter',
    youbot: 'you.bot',
    cheapai: 'CheapAI',
  });
});

test('you.bot adapter returns inline text from a synchronous generate response', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  const { fetch, calls } = mockFetch([jsonResponse(200, { taskId: 't1', text: 'pong', usage: {} })]);
  t.mock.method(globalThis, 'fetch', fetch);

  const adapter = createYoubotAdapter({ baseUrl: `${baseUrl}/`, sleep: noSleep });
  assert.equal(await adapter.complete(request, youbotContext), 'pong');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${baseUrl}/generate`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.modelId, 'claude-sonnet-5');
  assert.deepEqual(body.input, {
    prompt: 'Say pong',
    max_tokens: 16,
    temperature: 0,
    memory: false,
    thinking: false,
    stream: false,
    web_search: false,
  });
});

test('you.bot adapter polls the task until text arrives', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  const { fetch, calls } = mockFetch([
    jsonResponse(200, { taskId: 'abc' }),
    jsonResponse(200, { taskId: 'abc', status: 'processing' }),
    jsonResponse(200, { taskId: 'abc', status: 'completed', text: 'done' }),
  ]);
  t.mock.method(globalThis, 'fetch', fetch);

  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep, pollIntervalMs: 1 });
  assert.equal(await adapter.complete(request, youbotContext), 'done');

  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, `${baseUrl}/task/abc?model=claude-sonnet-5`);
  assert.equal(calls[1].init.method, undefined);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer sk-test');
});

test('you.bot adapter surfaces failed tasks and times out on stuck ones', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');

  const failing = mockFetch([
    jsonResponse(200, { taskId: 'bad' }),
    jsonResponse(200, { taskId: 'bad', status: 'failed', error: { message: 'model overloaded' } }),
  ]);
  t.mock.method(globalThis, 'fetch', failing.fetch);
  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep, pollIntervalMs: 1 });
  await assert.rejects(() => adapter.complete(request, youbotContext), /task bad failed: model overloaded/);

  t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, { taskId: 'slow', status: 'processing' }));
  const impatient = createYoubotAdapter({
    baseUrl,
    pollIntervalMs: 1,
    taskTimeoutMs: 20,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 5))),
  });
  await assert.rejects(() => impatient.complete(request, youbotContext), /did not complete within 20ms/);
});

test('you.bot adapter retries retriable HTTP errors and gives up on client errors', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  t.mock.method(console, 'warn', () => {});

  const flaky = mockFetch([
    jsonResponse(503, { error: 'Service temporarily unavailable', code: 'unavailable' }),
    jsonResponse(200, { taskId: 't', text: 'recovered' }),
  ]);
  t.mock.method(globalThis, 'fetch', flaky.fetch);
  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep, retry: { baseDelayMs: 1 } });
  assert.equal(await adapter.complete(request, youbotContext), 'recovered');
  assert.equal(flaky.calls.length, 2);

  const unauthorized = mockFetch([jsonResponse(401, { error: 'bad key' })]);
  t.mock.method(globalThis, 'fetch', unauthorized.fetch);
  await assert.rejects(
    () => adapter.complete(request, youbotContext),
    (error) => {
      assert.equal(error.name, 'ProviderRequestError');
      assert.equal(error.providerId, 'youbot');
      assert.equal(error.status, 401);
      assert.match(error.message, /you\.bot API error \(401\)/);
      return true;
    }
  );
  assert.equal(unauthorized.calls.length, 1);
});

test('completeText clamps the requested max_tokens to the provider ceiling', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('providers-clamp');
  process.env.YOUBOT_API_KEY = 'env-youbot-key';
  process.env.YOUBOT_MAX_OUTPUT_TOKENS = '';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');

  assert.equal(providers.getProviderMaxOutputTokens('youbot'), 12000);
  process.env.YOUBOT_MAX_OUTPUT_TOKENS = '24000';
  assert.equal(providers.getProviderMaxOutputTokens('youbot'), 24000);
  process.env.YOUBOT_MAX_OUTPUT_TOKENS = 'lots';
  assert.equal(providers.getProviderMaxOutputTokens('youbot'), 12000, 'a non-numeric override is ignored');
  process.env.YOUBOT_MAX_OUTPUT_TOKENS = '';

  // The call site asks for 32000; the provider is only ever sent its ceiling.
  const { fetch, calls } = mockFetch([jsonResponse(200, { taskId: 't', text: 'ok', usage: { outputTokens: 5 } })]);
  t.mock.method(globalThis, 'fetch', fetch);
  await providers.completeText('youbot', { ...request, maxTokens: 32000 });
  assert.equal(JSON.parse(calls[0].init.body).input.max_tokens, 12000);
  process.env.YOUBOT_API_KEY = '';
});

test('completeText wires settings, environment keys, and the adapter together', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('providers-dispatch');
  process.env.YOUBOT_API_KEY = '';
  process.env.YOUBOT_MODEL = '';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');
  t.mock.method(console, 'log', () => {});

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be reached without an API key');
  });
  await assert.rejects(() => providers.completeText('youbot', request), /you\.bot API key is not set/);

  process.env.YOUBOT_API_KEY = 'env-youbot-key';
  const { fetch, calls } = mockFetch([jsonResponse(200, { taskId: 't', text: 'wired' })]);
  t.mock.method(globalThis, 'fetch', fetch);
  assert.equal(await providers.completeText('youbot', request), 'wired');
  assert.equal(calls[0].url, 'https://you.bot/api/v1/generate');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer env-youbot-key');
  assert.equal(JSON.parse(calls[0].init.body).modelId, 'claude-sonnet-5');

  // A listed model travels through to the request body; an unlisted one never reaches the network.
  process.env.YOUBOT_MODEL = 'claude-sonnet-5,claude-haiku-4-5';
  const haiku = mockFetch([
    jsonResponse(200, { taskId: 't2', text: 'haiku' }),
    jsonResponse(200, { taskId: 't3', text: 'wire form' }),
  ]);
  t.mock.method(globalThis, 'fetch', haiku.fetch);
  assert.equal(await providers.completeText({ providerId: 'youbot', model: 'claude-haiku-4-5' }, request), 'haiku');
  assert.equal(await providers.completeText('youbot/claude-haiku-4-5', request), 'wire form');
  assert.deepEqual(haiku.calls.map((call) => JSON.parse(call.init.body).modelId), ['claude-haiku-4-5', 'claude-haiku-4-5']);
  await assert.rejects(() => providers.completeText('youbot/claude-opus-5', request), /you\.bot does not offer the model "claude-opus-5"/);
  assert.equal(haiku.calls.length, 2, 'an unlisted model must not reach the network');
  process.env.YOUBOT_MODEL = '';
  process.env.YOUBOT_API_KEY = '';
});

test('completeJson retries an unusable reply and accepts the retry', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('complete-json-retry');
  process.env.YOUBOT_API_KEY = 'env-youbot-key';
  process.env.YOUBOT_MODEL = '';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  // First reply: a complete object with a syntax error in coverLetter. It balances, so a
  // naive scan would descend into it and return the valid experience array instead.
  const broken = [
    '{',
    '  "title": "Senior Software Engineer",',
    '  "experience": [{ "title": "Engineer", "company": "JPMorgan Chase & Co" }],',
    '  "coverLetter": "I said "hello" to the team."',
    '}',
  ].join('\n');
  const good = JSON.stringify({ title: 'Senior Software Engineer', experience: [{ title: 'Engineer' }] });

  const { fetch, calls } = mockFetch([
    jsonResponse(200, { taskId: 't1', text: broken }),
    jsonResponse(200, { taskId: 't2', text: good }),
  ]);
  t.mock.method(globalThis, 'fetch', fetch);

  const result = await providers.completeJson('youbot', request, 'the tailored resume');
  assert.equal(calls.length, 2, 'should have made a second, billable attempt');
  assert.equal(result.title, 'Senior Software Engineer');
  assert.equal(result.experience.length, 1);
  process.env.YOUBOT_API_KEY = '';
});

test('completeJson gives up after the attempt budget and reports why', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('complete-json-giveup');
  process.env.YOUBOT_API_KEY = 'env-youbot-key';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  // A bare array: valid JSON, wrong shape. Spreading it would yield {"0":...} and lose
  // experience, summary and strengths — the exact silent failure this guards against.
  const arrayReply = JSON.stringify([{ title: 'Engineer', company: 'JPMorgan Chase & Co' }]);
  const { fetch, calls } = mockFetch([
    jsonResponse(200, { taskId: 'a', text: arrayReply }),
    jsonResponse(200, { taskId: 'b', text: arrayReply }),
    jsonResponse(200, { taskId: 'c', text: arrayReply }),
    jsonResponse(200, { taskId: 'd', text: arrayReply }),
  ]);
  t.mock.method(globalThis, 'fetch', fetch);

  await assert.rejects(
    () => providers.completeJson('youbot', request, 'the tailored resume'),
    /Expected the tailored resume to be a JSON object but the model returned an array/
  );
  assert.equal(calls.length, 4, 'four paid attempts, then give up');

  // maxAttempts is honourable, so a caller can opt out of paying for a retry.
  const single = mockFetch([jsonResponse(200, { taskId: 'e', text: arrayReply })]);
  t.mock.method(globalThis, 'fetch', single.fetch);
  await assert.rejects(
    () => providers.completeJson('youbot', request, 'the tailored resume', { maxAttempts: 1 }),
    /returned an array/
  );
  assert.equal(single.calls.length, 1);
  process.env.YOUBOT_API_KEY = '';
});

test('completeJson treats a prose reply as the model declining, and does not pay to ask again', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('complete-json-decline');
  process.env.YOUBOT_API_KEY = 'env-youbot-key';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');
  const { classifyFailure } = loadFresh('../dist/providers/retry');
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  // Seen live via CheapAI: the model explained why it would not invent qualifications,
  // in prose, with no JSON anywhere — the same answer would come back on every attempt.
  const refusal = "I can't build this one as specified. The candidate profile shows no evidence of Unreal Engine work. A few ways I can actually help: 1. Build it honestly.";
  const { fetch, calls } = mockFetch([
    jsonResponse(200, { taskId: 'r1', text: refusal }),
    jsonResponse(200, { taskId: 'r2', text: refusal }),
  ]);
  t.mock.method(globalThis, 'fetch', fetch);

  await assert.rejects(
    () => providers.completeJson('youbot', request, 'the tailored resume'),
    (error) => {
      assert.match(error.message, /you.bot declined to write the tailored resume: "I can't build this one as specified."/);
      assert.equal(classifyFailure(error).retryable, false, 'a refusal is not re-sent within the call');
      assert.equal(classifyFailure(error).retryLater, true, 'but a refusal is not deterministic, so a later pass may try again');
      return true;
    }
  );
  assert.equal(calls.length, 1, 'no second paid attempt');
  process.env.YOUBOT_API_KEY = '';
});

test('you.bot adapter does not trust inline text while the task is still running', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  // A sync reply that returns the partial text so far plus a pending status: the adapter
  // must keep polling for the finished text instead of returning the fragment.
  const { fetch, calls } = mockFetch([
    jsonResponse(200, { taskId: 'p1', status: 'processing', text: '{"title":"Senior' }),
    jsonResponse(200, { taskId: 'p1', status: 'processing', text: '{"title":"Senior Software' }),
    jsonResponse(200, { taskId: 'p1', status: 'completed', text: '{"title":"Senior Software Engineer"}' }),
  ]);
  t.mock.method(globalThis, 'fetch', fetch);

  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep, pollIntervalMs: 1 });
  assert.equal(await adapter.complete(request, youbotContext), '{"title":"Senior Software Engineer"}');
  assert.equal(calls.length, 3);
});

test('you.bot adapter treats a reply that used the whole max_tokens budget as cut off', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep, pollIntervalMs: 1 });
  const budgeted = { ...request, maxTokens: 11000 };

  // Exactly what the live probe returned: HTTP 200, text stops mid-sentence, no finish
  // reason anywhere, usage.outputTokens equal to the requested limit.
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(200, { taskId: 'cap', text: '{"title":"Senior Software Engineer","coverLetter":"I have spent', usage: { inputTokens: 8051, outputTokens: 11000 } })
  );
  await assert.rejects(() => adapter.complete(budgeted, youbotContext), /cut off at the 11000-token output limit/);

  // Under the budget: a finished reply is returned untouched.
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(200, { taskId: 'ok', text: '{"title":"Senior Software Engineer"}', usage: { inputTokens: 8051, outputTokens: 2942 } })
  );
  assert.equal(await adapter.complete(budgeted, youbotContext), '{"title":"Senior Software Engineer"}');

  // The same rule applies to text that arrives through polling.
  const polled = mockFetch([
    jsonResponse(200, { taskId: 'p' }),
    jsonResponse(200, { taskId: 'p', status: 'completed', text: 'cut', usage: { outputTokens: 11000 } }),
  ]);
  t.mock.method(globalThis, 'fetch', polled.fetch);
  await assert.rejects(() => adapter.complete(budgeted, youbotContext), /cut off at the 11000-token output limit/);
});

test('you.bot adapter explains a 402 in terms of the reservation, not the real cost', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep });

  // you.bot reserves (prompt + max_tokens) up front, so a run that would spend ~2 credits
  // is refused for needing ~14. The raw message reads as nonsense without that context.
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(402, {
      error: 'Insufficient credits: this call may cost up to 13.72, balance is 12.42.',
      code: 'insufficient_credits',
      need: 13.72,
      have: 12.42,
    })
  );

  await assert.rejects(
    () => adapter.complete({ ...request, maxTokens: 16000 }, youbotContext),
    (error) => {
      assert.equal(error.status, 402);
      assert.match(error.message, /reserves the worst-case cost up front/);
      assert.match(error.message, /16000-token output limit is 13.72 credits/);
      assert.match(error.message, /balance is 12.42/);
      // 16000 * 12.42 / 13.72 = 14484 -> rounded down to the nearest 500.
      assert.match(error.message, /YOUBOT_MAX_OUTPUT_TOKENS=14000/);
      return true;
    }
  );
});

test('you.bot adapter tells the user to top up when no usable ceiling fits', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep });

  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(402, { error: 'Insufficient credits: this call may cost up to 13.72, balance is 0.90.' })
  );

  await assert.rejects(
    () => adapter.complete({ ...request, maxTokens: 16000 }, youbotContext),
    /Top up the account/
  );
});

test('anthropic adapter turns cached segments into cache_control content blocks', async (t) => {
  const { anthropicAdapter } = loadFresh('../dist/providers/adapters/anthropic');
  const { fetch, calls } = mockFetch([jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] })]);
  t.mock.method(globalThis, 'fetch', fetch);

  const prompt = [{ text: 'RULES', cache: true }, { text: 'JOB', cache: true }, { text: 'PROFILE' }];
  const context = { providerId: 'claude', apiKey: 'k', model: 'claude-sonnet-4-20250514' };
  assert.equal(await anthropicAdapter.complete({ ...request, prompt }, context), 'ok');

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'RULES', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'JOB', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'PROFILE' },
  ]);

  // A plain string is sent as before.
  t.mock.method(globalThis, 'fetch', mockFetch([jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] })]).fetch);
  const plain = mockFetch([jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] })]);
  t.mock.method(globalThis, 'fetch', plain.fetch);
  await anthropicAdapter.complete(request, context);
  assert.equal(JSON.parse(plain.calls[0].init.body).messages[0].content, 'Say pong');
});

test('you.bot adapter sends segmented prompts as one string, in order', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  t.mock.method(console, 'log', () => {});
  const { fetch, calls } = mockFetch([jsonResponse(200, { taskId: 't', text: 'pong', usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 0 }, creditsCharged: 0.01 })]);
  t.mock.method(globalThis, 'fetch', fetch);

  // Opted out of caching, the segments collapse to flat text in order.
  process.env.YOUBOT_PROMPT_CACHE = '0';
  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep });
  const prompt = [{ text: 'RULES ', cache: true }, { text: 'JOB ', cache: true }, { text: 'PROFILE' }];
  assert.equal(await adapter.complete({ ...request, prompt }, youbotContext), 'pong');
  assert.equal(JSON.parse(calls[0].init.body).input.prompt, 'RULES JOB PROFILE');
  assert.match(console.log.mock.calls[0].arguments[0], /3 uncached in \/ 1 out — 0.01 credits \(cache: 2 read, 0 written\)/);
  delete process.env.YOUBOT_PROMPT_CACHE;
});

test('you.bot adapter marks the stable prefix with cache_control by default', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  t.mock.method(console, 'log', () => {});
  delete process.env.YOUBOT_PROMPT_CACHE;

  // Verified live: you.bot bills the marked prefix at the cache-write rate once, then at
  // the cached-input rate, and the model reads it either way.
  const prompt = [{ text: 'RULES ', cache: true }, { text: 'JOB ', cache: true }, { text: 'PROFILE' }];
  const { fetch, calls } = mockFetch([jsonResponse(200, { taskId: 't', text: 'pong' })]);
  t.mock.method(globalThis, 'fetch', fetch);

  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep });
  await adapter.complete({ ...request, prompt }, youbotContext);

  const input = JSON.parse(calls[0].init.body).input;
  assert.equal(input.prompt, undefined, 'messages and prompt are mutually exclusive');
  assert.deepEqual(input.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'RULES ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'JOB ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'PROFILE' },
      ],
    },
  ]);

  // A plain string prompt has nothing to cache and keeps the simpler form.
  const plain = mockFetch([jsonResponse(200, { taskId: 't', text: 'pong' })]);
  t.mock.method(globalThis, 'fetch', plain.fetch);
  await adapter.complete(request, youbotContext);
  assert.equal(JSON.parse(plain.calls[0].init.body).input.prompt, 'Say pong');
});

test('you.bot adapter retries a duplicate-request 409 instead of failing the generation', async (t) => {
  const { createYoubotAdapter } = loadFresh('../dist/providers/adapters/youbot');
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});

  const { fetch, calls } = mockFetch([
    jsonResponse(409, { error: 'Duplicate request — an identical generation was just submitted.', code: 'duplicate_request' }),
    jsonResponse(200, { taskId: 't', text: 'recovered' }),
  ]);
  t.mock.method(globalThis, 'fetch', fetch);

  const adapter = createYoubotAdapter({ baseUrl, sleep: noSleep, retry: { baseDelayMs: 1, sleep: noSleep } });
  assert.equal(await adapter.complete(request, youbotContext), 'recovered');
  assert.equal(calls.length, 2);
});
