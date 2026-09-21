const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, makeTempDataDir } = require('./helpers');

test('CheapAI is a registered provider with its own key, model list and wire prefix', () => {
  const registry = loadFresh('../dist/providers/registry');
  const definition = registry.getProviderDefinition('cheapai');
  assert.equal(definition.label, 'CheapAI');
  assert.deepEqual(definition.envApiKeyNames, ['CHEAPAI_API_KEY']);

  process.env.CHEAPAI_MODEL = '';
  assert.equal(registry.getProviderModel('cheapai'), 'claude-haiku-4-5-20251001', 'Haiku is the default, as on you.bot');
  assert.deepEqual(registry.resolveModelSelection('cheapai/gpt-5.6-luna'), { providerId: 'cheapai', model: 'gpt-5.6-luna' });
  // Listed in CheapAI's catalog but deliberately left out of the picker: it answers 400 Upstream error.
  assert.throws(() => registry.resolveModelSelection('cheapai/grok-4.20-reasoning'), /CheapAI does not offer the model "grok-4.20-reasoning"/);
  assert.equal(registry.resolveProviderId('cheapai/anything'), 'cheapai');

  process.env.CHEAPAI_MODEL = 'claude-opus-4-8, gpt-5.6-sol';
  assert.deepEqual(registry.getProviderModels('cheapai'), ['claude-opus-4-8', 'gpt-5.6-sol'], 'the env list replaces the default one');
  process.env.CHEAPAI_MODEL = '';
});

test('CheapAI calls the OpenAI-compatible chat endpoint with the bearer key and the chosen model', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('cheapai-dispatch');
  process.env.CHEAPAI_API_KEY = 'sk-cheap-test';
  process.env.CHEAPAI_MODEL = '';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(line));

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"ok"}' } }], usage: { prompt_tokens: 7783, completion_tokens: 2002, billing_usage: { claude_usage: { cache_creation_input_tokens: 7781, cache_read_input_tokens: 0 } } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const prompt = [{ text: 'RULES ', cache: true }, { text: 'JOB ', cache: true }, { text: 'PROFILE' }];
  const reply = await providers.completeText('cheapai/claude-sonnet-5', {
    prompt,
    maxTokens: 500,
    temperature: 0.2,
    responseFormat: 'json',
  });
  assert.equal(reply, '{"title":"ok"}');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cheapai.io/v1/chat/completions');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer sk-cheap-test');
  assert.equal(logged.at(-1), 'CheapAI claude-sonnet-5: 7783 in / 2002 out (cache: 0 read, 7781 written)');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-sonnet-5');
  assert.equal(body.max_tokens, 500, 'a gateway takes the classic field');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.reasoning_effort, 'low', 'its Claude models think at length, and run out of gateway time, unless told not to');
  assert.deepEqual(body.messages.at(-1).content, [
    { type: 'text', text: 'RULES ', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'JOB ', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'PROFILE' },
  ], 'segments become content parts with cache markers on the stable prefixes');
  assert.equal(body.messages[0].role, 'system', 'the JSON instruction stays ahead of the cached prefix');

  // The same transport without the option (OpenRouter) still sends flat text.
  const { openrouterAdapter } = loadFresh('../dist/providers/adapters/openrouter');
  await openrouterAdapter.complete({ prompt, maxTokens: 5, temperature: 0, responseFormat: 'text' }, { providerId: 'openrouter', apiKey: 'k', model: 'openai/gpt-5.4-nano' });
  assert.equal(JSON.parse(calls.at(-1).init.body).messages.at(-1).content, 'RULES JOB PROFILE');
  assert.equal(JSON.parse(calls.at(-1).init.body).reasoning_effort, undefined, 'only CheapAI asks for a reasoning depth');
  calls.length = 1;

  // Without a key the network is never reached.
  process.env.CHEAPAI_API_KEY = '';
  loadFresh('../dist/config/aiModelConfig');
  const fresh = loadFresh('../dist/providers/index');
  await assert.rejects(() => fresh.completeText('cheapai', { prompt: 'x', maxTokens: 5, temperature: 0, responseFormat: 'text' }), /CheapAI API key is not set/);
  assert.equal(calls.length, 1);
});

test('a Cloudflare 524 from CheapAI is explained, marked permanent, and never re-sent', async (t) => {
  process.env.TAILOR_DATA_DIR = makeTempDataDir('cheapai-524');
  process.env.CHEAPAI_API_KEY = 'sk-cheap-test';
  process.env.AI_RETRY_BUDGET_MS = '0';
  loadFresh('../dist/config/aiModelConfig');
  const providers = loadFresh('../dist/providers/index');
  const { classifyFailure } = loadFresh('../dist/providers/retry');
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('<html>524</html>', { status: 524, headers: { 'content-type': 'text/html' } });
  });

  await assert.rejects(
    () => providers.completeText('cheapai/claude-sonnet-5', { prompt: 'x', maxTokens: 5, temperature: 0, responseFormat: 'text' }),
    (error) => {
      assert.ok(error.message.includes('CheapAI gave up waiting for claude-sonnet-5 after about two minutes (HTTP 524)'), error.message);
      assert.equal(error.status, 524);
      assert.equal(classifyFailure(error).retryable, false);
      assert.equal(classifyFailure(error).retryLater, true, 'parked for a later pass, never re-sent within the call');
      return true;
    }
  );
  assert.equal(calls, 1, 'neither the SDK nor the dispatcher re-sends a 524');
  delete process.env.AI_RETRY_BUDGET_MS;
  process.env.CHEAPAI_API_KEY = '';
});

test('a CheapAI call that never answers is abandoned at the per-attempt cap, not after the SDK default', async (t) => {
  const { createOpenAiCompatibleAdapter } = loadFresh('../dist/providers/adapters/openaiCompatible');
  t.mock.method(console, 'log', () => {});
  // A request that hangs forever unless the client aborts it — what a 30-minute spinner looked like.
  t.mock.method(globalThis, 'fetch', (url, init = {}) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  }));

  const adapter = createOpenAiCompatibleAdapter({
    providerId: 'cheapai',
    baseURL: 'https://cheapai.io/v1',
    maxTokensParam: 'max_tokens',
    timeoutMs: () => 50,
    maxRetries: 0,
  });
  const started = Date.now();
  await assert.rejects(
    () => adapter.complete({ prompt: 'x', maxTokens: 5, temperature: 0, responseFormat: 'text' }, { providerId: 'cheapai', apiKey: 'k', model: 'claude-sonnet-5' }),
    /timed out/i
  );
  assert.ok(Date.now() - started < 5000, 'gave up within the cap instead of waiting the SDK default of 10 minutes');
});

test('the CheapAI reasoning depth comes from CHEAPAI_REASONING_EFFORT in any casing, else low', (t) => {
  const { resolveCheapaiReasoningEffort } = loadFresh('../dist/providers/adapters/cheapai');
  const warnings = [];
  t.mock.method(console, 'warn', (line) => warnings.push(line));
  const saved = process.env.CHEAPAI_REASONING_EFFORT;

  delete process.env.CHEAPAI_REASONING_EFFORT;
  assert.equal(resolveCheapaiReasoningEffort(), 'low', 'the level that switches the hidden thinking off');
  process.env.CHEAPAI_REASONING_EFFORT = 'High';
  assert.equal(resolveCheapaiReasoningEffort(), 'high');
  assert.equal(resolveCheapaiReasoningEffort('XHIGH'), 'xhigh');
  assert.equal(resolveCheapaiReasoningEffort('none'), 'none');
  assert.equal(resolveCheapaiReasoningEffort('deep'), 'low');
  assert.equal(resolveCheapaiReasoningEffort('deep'), 'low');
  assert.equal(warnings.length, 1, 'an unusable value is reported once, not per call');
  assert.match(warnings[0], /CHEAPAI_REASONING_EFFORT="deep" is not one of none, minimal, low, medium, high, xhigh; using low/);

  if (saved === undefined) delete process.env.CHEAPAI_REASONING_EFFORT; else process.env.CHEAPAI_REASONING_EFFORT = saved;
});
