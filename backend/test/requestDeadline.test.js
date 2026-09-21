const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a request past the deadline is answered with a retryable 503, and the late handler cannot crash the server', async () => {
  const { requestDeadline } = loadFresh('../dist/middleware/requestDeadline');
  const app = express();
  app.use(requestDeadline(60));
  let lateHandlerFinished = false;
  app.post('/slow', async (_req, res) => {
    await sleep(200);
    res.status(200).json({ ok: true }); // headers already sent by the deadline answer: must be a no-op
    lateHandlerFinished = true;
  });
  app.post('/fast', (_req, res) => {
    res.json({ ok: true });
  });

  await withServer(app, async (base) => {
    const started = Date.now();
    const slow = await fetch(`${base}/slow`, { method: 'POST' });
    assert.equal(slow.status, 503);
    const body = await slow.json();
    assert.equal(body.retryable, true, 'the browser loop retries it in a later pass');
    assert.match(body.error, /did not finish this request within 1 minute/);
    assert.ok(Date.now() - started < 190, 'answered at the deadline, not when the handler finished');

    await sleep(250);
    assert.equal(lateHandlerFinished, true, 'the late res.json returned quietly');

    const fast = await fetch(`${base}/fast`, { method: 'POST' });
    assert.equal(fast.status, 200);
    assert.deepEqual(await fast.json(), { ok: true });
  });
});

test('the deadline comes from BUILD_DEADLINE_MS, defaults to 30 minutes, and 0 disables it', async () => {
  const { readDeadlineMs, requestDeadline } = loadFresh('../dist/middleware/requestDeadline');
  assert.equal(readDeadlineMs(undefined), 30 * 60_000);
  assert.equal(readDeadlineMs(''), 30 * 60_000);
  assert.equal(readDeadlineMs('120000'), 120_000);
  assert.equal(readDeadlineMs('0'), 0);
  assert.equal(readDeadlineMs('soon'), 30 * 60_000, 'an unusable value falls back to the default');

  const app = express();
  app.use(requestDeadline(0));
  app.post('/slow', async (_req, res) => {
    await sleep(80);
    res.json({ ok: true });
  });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/slow`, { method: 'POST' });
    assert.equal(res.status, 200, 'no deadline when disabled');
  });
});
