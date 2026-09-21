const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

test('classifyFailure separates a provider having a bad moment from one that needs a person', () => {
  const { classifyFailure } = loadFresh('../dist/providers/retry');
  const { ProviderRequestError } = loadFresh('../dist/providers/types');
  const { UnknownModelError } = loadFresh('../dist/providers/registry');
  const withStatus = (status) => new ProviderRequestError('youbot', `error ${status}`, status);

  for (const status of [500, 502, 503, 504, 408, 409, 422, 425, 429]) {
    assert.equal(classifyFailure(withStatus(status)).retryable, true, `${status} is worth another try`);
  }
  for (const status of [400, 401, 402, 403, 404, 413]) {
    assert.equal(classifyFailure(withStatus(status)).retryable, false, `${status} will repeat until someone acts`);
  }
  assert.equal(classifyFailure(withStatus(524)).retryable, false, 'a Cloudflare 524 means the model is too slow for the request; re-sending only re-bills it');
  assert.equal(classifyFailure(withStatus(524)).retryLater, true, 'but it is load-dependent, so a later pass may succeed');
  assert.equal(classifyFailure(withStatus(503)).retryLater, undefined);
  assert.equal(classifyFailure(new ProviderRequestError('cheapai', 'declined', undefined, false, true)).retryLater, true, 'an explicit later-verdict travels with the error');
  assert.equal(classifyFailure(withStatus(503)).status, 503);

  // An explicit verdict wins over the status, and a missing status means "try again".
  assert.equal(classifyFailure(new ProviderRequestError('youbot', 'API key is not set', undefined, false)).retryable, false);
  assert.equal(classifyFailure(new ProviderRequestError('youbot', 'cut off at the limit')).retryable, true);
  assert.equal(classifyFailure(new Error('Unexpected response from CheapAI')).retryable, true);
  assert.equal(classifyFailure(new UnknownModelError('youbot', 'nope')).retryable, false);
  // Errors from the OpenAI SDK carry `status` too.
  assert.equal(classifyFailure(Object.assign(new Error('rate limited'), { status: 429 })).retryable, true);
  assert.equal(classifyFailure(Object.assign(new Error('bad request'), { status: 400 })).retryable, false);
  assert.equal(classifyFailure(Object.assign(new Error('Request timed out.'), { status: undefined })).retryable, true);
});

test('retryTransient keeps trying with doubling delays until success, and stops at a permanent failure', async () => {
  const { retryTransient } = loadFresh('../dist/providers/retry');
  const { ProviderRequestError } = loadFresh('../dist/providers/types');
  let clock = 0;
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); clock += ms; };
  const now = () => clock;

  let calls = 0;
  const result = await retryTransient(
    async () => {
      calls += 1;
      if (calls < 3) throw new ProviderRequestError('youbot', 'overloaded', 503);
      return 'done';
    },
    { budgetMs: 60_000, sleep, now, jitterMs: 0 }
  );
  assert.equal(result, 'done');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [2_000, 4_000], 'second and third attempts wait 2 s then 4 s');

  calls = 0;
  await assert.rejects(
    () => retryTransient(
      async () => { calls += 1; throw new ProviderRequestError('youbot', 'bad key', 401); },
      { budgetMs: 60_000, sleep, now, jitterMs: 0 }
    ),
    /bad key/
  );
  assert.equal(calls, 1, 'a permanent failure is not retried');
});

test('retryTransient never waits past its budget, and a zero budget means one attempt', async () => {
  const { retryTransient } = loadFresh('../dist/providers/retry');
  const { ProviderRequestError } = loadFresh('../dist/providers/types');
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  const now = () => clock;
  const seen = [];

  let calls = 0;
  await assert.rejects(
    () => retryTransient(
      async () => { calls += 1; throw new ProviderRequestError('youbot', 'still down', 503); },
      { budgetMs: 5_000, sleep, now, jitterMs: 0, onRetry: (info) => seen.push([info.attempt, info.delayMs, info.remainingMs]) }
    ),
    /still down/
  );
  // Attempt 1 fails at t=0: a 2 s wait fits the 5 s budget. Attempt 2 fails at t=2 s: the
  // next wait would be 4 s with 3 s left, so the error is surfaced instead.
  assert.equal(calls, 2);
  assert.deepEqual(seen, [[1, 2_000, 3_000]]);

  calls = 0;
  await assert.rejects(() =>
    retryTransient(async () => { calls += 1; throw new ProviderRequestError('youbot', 'x', 503); }, { budgetMs: 0, sleep, now })
  );
  assert.equal(calls, 1);
});

test('the retry budget comes from AI_RETRY_BUDGET_MS, defaulting to ten minutes', () => {
  const { getRetryBudgetMs } = loadFresh('../dist/providers/retry');
  const saved = process.env.AI_RETRY_BUDGET_MS;
  process.env.AI_RETRY_BUDGET_MS = '';
  assert.equal(getRetryBudgetMs(), 600_000);
  process.env.AI_RETRY_BUDGET_MS = '0';
  assert.equal(getRetryBudgetMs(), 0);
  process.env.AI_RETRY_BUDGET_MS = '45000';
  assert.equal(getRetryBudgetMs(), 45_000);
  process.env.AI_RETRY_BUDGET_MS = 'forever';
  assert.equal(getRetryBudgetMs(), 600_000, 'an unusable value falls back to the default');
  process.env.AI_RETRY_BUDGET_MS = saved ?? '';
});
