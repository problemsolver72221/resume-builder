const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const net = require('node:net');

const { listenOnFreePort, PORT_STEP } = require('../dist/utils/listenOnFreePort');

const HOST = '127.0.0.1';

function makeApp() {
  const app = express();
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

/** An unrelated process holding a port, which is what a second copy of the project looks like. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

test('the first free port at or above the base is bound', async () => {
  const { server, port } = await listenOnFreePort(makeApp(), { host: HOST, port: 0 });
  try {
    assert.ok(port > 0, 'a real port was chosen');
    assert.equal(server.address().port, port);
  } finally {
    await close(server);
  }
});

test('a port another copy already holds is skipped, stepping by PORT_STEP', async () => {
  // Bind 0 first to find a base that is genuinely free, then hand it to a squatter.
  const probe = await occupy(0);
  const base = probe.address().port;
  await close(probe);

  const squatter = await occupy(base);
  try {
    const { server, port } = await listenOnFreePort(makeApp(), { host: HOST, port: base });
    try {
      assert.equal(port, base + PORT_STEP, 'moved up one step instead of failing');
      assert.notEqual(port, base);
    } finally {
      await close(server);
    }
  } finally {
    await close(squatter);
  }
});

test('two servers started at once never land on the same port', async () => {
  const probe = await occupy(0);
  const base = probe.address().port;
  await close(probe);

  const started = await Promise.all([
    listenOnFreePort(makeApp(), { host: HOST, port: base }),
    listenOnFreePort(makeApp(), { host: HOST, port: base }),
    listenOnFreePort(makeApp(), { host: HOST, port: base }),
  ]);
  try {
    const ports = started.map((entry) => entry.port);
    assert.equal(new Set(ports).size, ports.length, `distinct ports, got ${ports.join(', ')}`);
  } finally {
    await Promise.all(started.map((entry) => close(entry.server)));
  }
});

test('the search gives up rather than walking forever', async () => {
  const probe = await occupy(0);
  const base = probe.address().port;
  await close(probe);

  const squatter = await occupy(base);
  try {
    await assert.rejects(
      () => listenOnFreePort(makeApp(), { host: HOST, port: base, attempts: 1 }),
      (error) => error.code === 'EADDRINUSE'
    );
  } finally {
    await close(squatter);
  }
});
