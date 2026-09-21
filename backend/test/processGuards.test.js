const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const MODULE = path.join(__dirname, '..', 'dist', 'processGuards.js');

/**
 * Runs a script in a fresh Node process. The test runner installs its own fatal-error
 * listeners in this process, so the only honest way to check that the guards keep a
 * process alive is to let real unhandled errors happen in one that has nothing else.
 */
function runNode(script) {
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const withGuards = (body) => `
  const { installProcessGuards } = require(${JSON.stringify(MODULE)});
  installProcessGuards((message) => process.stdout.write(message + '\\n'));
  ${body}
  setTimeout(() => process.stdout.write('still alive\\n'), 80);
`;

test('a real unhandled rejection and a real uncaught exception are logged and the process stays up', () => {
  const run = runNode(withGuards(`
    Promise.reject(new Error('nobody awaited me'));
    setTimeout(() => { throw new Error('escaped a callback'); }, 5);
  `));

  assert.equal(run.code, 0, `process should exit cleanly, stderr: ${run.stderr}`);
  assert.match(run.stdout, /Unhandled promise rejection — the server keeps running/);
  assert.match(run.stdout, /nobody awaited me/);
  assert.match(run.stdout, /^\[\d{4}-\d{2}-\d{2}T/m, 'stamped so it can be lined up with the batch log');
  assert.match(run.stdout, /Uncaught exception — the server keeps running, but restart it/);
  assert.match(run.stdout, /escaped a callback/);
  assert.match(run.stdout, /\n\s+at /, 'the stack is included');
  assert.match(run.stdout, /still alive/, 'work scheduled after the errors still ran');
});

test('control: without the guards the same errors kill the process', () => {
  const run = runNode(`
    Promise.reject(new Error('nobody awaited me'));
    setTimeout(() => process.stdout.write('still alive\\n'), 80);
  `);
  assert.notEqual(run.code, 0);
  assert.doesNotMatch(run.stdout, /still alive/);
});

test('non-Error rejection reasons are still described', () => {
  const run = runNode(withGuards(`Promise.reject({ code: 'ECONNRESET', detail: 'socket closed' });`));
  assert.equal(run.code, 0);
  assert.match(run.stdout, /ECONNRESET/);
  assert.match(run.stdout, /still alive/);
});

test('dispose removes the listeners again', () => {
  const run = runNode(`
    const { installProcessGuards } = require(${JSON.stringify(MODULE)});
    const before = process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException');
    const dispose = installProcessGuards(() => {});
    const during = process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException');
    dispose();
    const after = process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException');
    process.stdout.write(JSON.stringify({ before, during, after }));
  `);
  assert.equal(run.code, 0, run.stderr);
  const counts = JSON.parse(run.stdout);
  assert.equal(counts.during, counts.before + 2);
  assert.equal(counts.after, counts.before);
});
