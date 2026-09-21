#!/usr/bin/env node
// Starts one instance of the app and keeps its two halves together.
//
// Several copies of this project are meant to run at the same time, each from its own
// folder, so neither port can be a fixed number. This picks the first free adjacent pair
// — 3000/3001, then 3002/3003, then 3004/3005 — starts the backend on the odd one, and
// starts the frontend on the even one pointed at whichever port the backend actually
// bound. Both halves recover on their own if another copy claims a port in between:
// the backend walks upwards internally, and the frontend is restarted a port higher.
//
// Env: PORT_BASE (3000), PORT_STEP (2), PORT_ATTEMPTS (25),
//      BACKEND_PORT_TIMEOUT_MS (120000).
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT_BASE = Number(process.env.PORT_BASE) || 3000;
const PORT_STEP = Number(process.env.PORT_STEP) || 2;
const PORT_ATTEMPTS = Number(process.env.PORT_ATTEMPTS) || 25;
const BACKEND_PORT_TIMEOUT_MS = Number(process.env.BACKEND_PORT_TIMEOUT_MS) || 120_000;
const HOST = process.env.HOST || '0.0.0.0';

const children = [];
let shuttingDown = false;

function isFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

/** The first pair (n, n+1) where both ports are free, walking up by PORT_STEP. */
async function findFreePair() {
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const frontendPort = PORT_BASE + attempt * PORT_STEP;
    const backendPort = frontendPort + 1;
    if ((await isFree(frontendPort)) && (await isFree(backendPort))) {
      return { frontendPort, backendPort };
    }
  }
  throw new Error(`no free port pair found in ${PORT_ATTEMPTS} tries from ${PORT_BASE}`);
}

function start(name, script, env) {
  const child = spawn('npm', ['run', script], {
    cwd: path.join(ROOT, name),
    env: { ...process.env, ...env },
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  children.push(child);

  const forward = (stream, target) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) target.write(`[${name}] ${line}\n`);
    });
    stream.on('end', () => {
      if (rest) target.write(`[${name}] ${rest}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return child;
}

function onExitStopEverything(name, child) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] ${name} exited (${signal ?? code}); stopping the other half too.`);
    shutdown(typeof code === 'number' ? code : 1);
  });
}

// child.kill() leaves grandchildren running on Windows, and the real dev servers are
// grandchildren of the npm wrapper.
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 500).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(0));
}

/** Resolves with the port the backend bound, which may not be the one it was asked for. */
function waitForBackendPort(child) {
  return new Promise((resolve, reject) => {
    let rest = '';
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`the backend did not report a port within ${Math.round(BACKEND_PORT_TIMEOUT_MS / 1000)}s`));
    }, BACKEND_PORT_TIMEOUT_MS);

    const onData = (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const match = /BACKEND_PORT=(\d+)/.exec(line);
        if (!match) continue;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(Number(match[1]));
        return;
      }
    };
    child.stdout.on('data', onData);
  });
}

/**
 * Next exits on a taken port rather than moving to the next one, and between the probe
 * above and the moment it binds, another copy may have claimed the port. So a start that
 * dies with EADDRINUSE is retried a step higher rather than taking the instance down.
 */
function startFrontend(port, apiUrl, attemptsLeft = PORT_ATTEMPTS) {
  // A variable set here wins over frontend/.env.local, so the frontend always talks to
  // its own backend rather than to whichever copy happens to hold the default port.
  const child = start('frontend', 'dev', { PORT: String(port), NEXT_PUBLIC_API_URL: apiUrl });
  let portTaken = false;

  const watch = (chunk) => {
    if (/EADDRINUSE/.test(String(chunk))) portTaken = true;
  };
  child.stdout.on('data', watch);
  child.stderr.on('data', watch);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (portTaken && attemptsLeft > 1) {
      const next = port + PORT_STEP;
      console.log(`[dev] port ${port} was taken while the frontend was starting; trying ${next}...`);
      children.splice(children.indexOf(child), 1);
      startFrontend(next, apiUrl, attemptsLeft - 1);
      return;
    }
    console.error(`[dev] frontend exited (${signal ?? code}); stopping the other half too.`);
    shutdown(typeof code === 'number' ? code : 1);
  });
  return child;
}

(async () => {
  const { frontendPort, backendPort } = await findFreePair();
  console.log(`[dev] starting this copy on ${frontendPort} (frontend) and ${backendPort} (backend)...`);

  const backend = start('backend', 'dev', { PORT: String(backendPort) });
  onExitStopEverything('backend', backend);

  const boundPort = await waitForBackendPort(backend);
  const apiUrl = `http://localhost:${boundPort}/api`;
  startFrontend(frontendPort, apiUrl);

  console.log(`[dev] backend on ${boundPort}; the frontend will call ${apiUrl}`);
})().catch((error) => {
  console.error(`[dev] ${error.message}`);
  shutdown(1);
});
