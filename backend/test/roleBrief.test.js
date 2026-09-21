const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clampRoleBrief,
  ensureMinLength,
  trimIncompleteEnd,
  MIN_ROLE_BRIEF_LENGTH,
  TAILORED_ROLE_BRIEF_MAX_LENGTH,
  RENDERED_ROLE_BRIEF_MAX_LENGTH,
} = require('../dist/services/utils/roleBrief');

const sentence = (length) => `${'word '.repeat(Math.ceil(length / 5)).slice(0, length - 1)}.`;

test('the tailoring cap is tighter than the renderer backstop', () => {
  // The renderer only clamps untailored text, so it must not cut what tailoring allowed.
  assert.ok(TAILORED_ROLE_BRIEF_MAX_LENGTH < RENDERED_ROLE_BRIEF_MAX_LENGTH);
  assert.ok(MIN_ROLE_BRIEF_LENGTH < TAILORED_ROLE_BRIEF_MAX_LENGTH);
});

test('text within the cap is returned with whitespace collapsed', () => {
  assert.equal(clampRoleBrief('  Led   the   platform team.  ', 100), 'Led the platform team.');
});

test('text already clamped for tailoring passes the renderer backstop untouched', () => {
  const tailored = clampRoleBrief(sentence(2000), TAILORED_ROLE_BRIEF_MAX_LENGTH);
  assert.equal(clampRoleBrief(tailored, RENDERED_ROLE_BRIEF_MAX_LENGTH), tailored);
});

test('a long brief is cut at the last sentence end near the cap', () => {
  const head = `${sentence(890)} `;
  const clamped = clampRoleBrief(`${head}And then a great deal more text that must not survive.`, 900);
  assert.ok(clamped.length <= 900);
  assert.ok(clamped.endsWith('.'));
  assert.ok(!clamped.includes('must not survive'));
});

test('a cut never leaves a dangling conjunction or comma', () => {
  assert.equal(trimIncompleteEnd('Owned reliability,'), 'Owned reliability');
  assert.equal(trimIncompleteEnd('Owned reliability or '), 'Owned reliability');
  // Removing the conjunction exposes the comma that preceded it; both must go.
  assert.equal(trimIncompleteEnd('Built pipelines, tooling, and'), 'Built pipelines, tooling');
  assert.equal(trimIncompleteEnd('Shipped APIs, dashboards, or'), 'Shipped APIs, dashboards');
  // A comma is not a conjunction, so a list that merely ends on one keeps its items.
  assert.equal(trimIncompleteEnd('Built pipelines, tooling,'), 'Built pipelines, tooling');
});

test('a cut never lands mid-word', () => {
  // No sentence or comma break anywhere, so it has to fall back to a word boundary.
  const clamped = clampRoleBrief('supercalifragilistic '.repeat(100).trim(), 200);
  assert.ok(clamped.length <= 200);
  assert.ok(!clamped.endsWith('supercalifragilisti'));
  assert.ok(clamped.split(' ').every((word) => word === 'supercalifragilistic'));
});

test('ensureMinLength pads only until the minimum is reached', () => {
  // 'Short brief.' is 12 and the first filler takes it to 35, clearing the minimum, so
  // the loop must stop before consuming the second.
  const padded = ensureMinLength('Short brief.', 30, ['Ran the release train.', 'Never reached.']);
  assert.equal(padded, 'Short brief. Ran the release train.');
  assert.ok(padded.length >= 30);
  assert.ok(!padded.includes('Never reached'));
});

test('ensureMinLength skips empty filler and leaves long text alone', () => {
  assert.equal(ensureMinLength('Already long enough.', 5, ['ignored']), 'Already long enough.');
  assert.equal(ensureMinLength('Brief.', 100, ['   ', '']), 'Brief.');
});
