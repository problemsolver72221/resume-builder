const assert = require('node:assert/strict');
const test = require('node:test');

const { createCoverLetterVariation, OMIT_COVER_LETTER_RECIPE } = require('../dist/services/coverLetterVariation');

test('switching the letter off overrides the letter rules instead of forking the prompt', () => {
  // It occupies the same slot as a brief, which is the prompt's volatile tail — the last
  // thing the model reads and the only part outside the cached prefix.
  assert.match(OMIT_COVER_LETTER_RECIPE, /DO NOT write a cover letter/);
  assert.match(OMIT_COVER_LETTER_RECIPE, /overrides every cover letter rule above/i);
  // An empty string keeps the reply schema-valid, so the JSON still parses.
  assert.match(OMIT_COVER_LETTER_RECIPE, /"coverLetter" to an empty string/);
  // The rest of the resume must still arrive in full.
  assert.match(OMIT_COVER_LETTER_RECIPE, /Every other field is still required/i);

  // It must not read like a brief, or the model may write to it anyway.
  assert.ok(!/Exactly \d+ paragraphs/.test(OMIT_COVER_LETTER_RECIPE));
});

test('each generation draws a different cover-letter brief and look', () => {
  const runs = Array.from({ length: 200 }, () => createCoverLetterVariation());

  // Paragraph count varies across 2-4 and every value shows up.
  const counts = new Set(runs.map((r) => r.paragraphCount));
  assert.deepEqual([...counts].sort(), [2, 3, 4]);
  for (const run of runs) assert.match(run.recipe, new RegExp(`Exactly ${run.paragraphCount} paragraphs`));

  // The shapes that made every old letter identical are explicitly ruled out.
  for (const phrase of ["I've spent the last", 'In my role at', "I'm also proud of"]) {
    assert.ok(runs[0].recipe.includes(phrase), 'the banned phrase is named in the brief');
  }

  // Briefs are genuinely varied, not one of a handful.
  const briefs = new Set(runs.map((r) => r.recipe));
  assert.ok(briefs.size > 100, `only ${briefs.size} distinct briefs in 200 draws`);

  // Colours vary, are never white, and stay dark enough to read on white paper.
  const colors = new Set(runs.map((r) => r.style.colorHex));
  assert.ok(colors.size >= 6, `only ${colors.size} distinct colours`);
  for (const hex of colors) {
    assert.match(hex, /^#[0-9A-F]{6}$/i);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    assert.ok(luminance < 140, `${hex} is too light to read on white (luminance ${luminance.toFixed(0)})`);
  }

  // Fonts, greetings and sign-offs vary; italics appear sometimes but not usually.
  assert.ok(new Set(runs.map((r) => r.style.fontDocx)).size >= 5);
  assert.ok(new Set(runs.map((r) => r.style.greeting)).size >= 3);
  assert.ok(new Set(runs.map((r) => r.style.signOff)).size >= 3);
  const italicised = runs.filter((r) => r.style.italic !== 'none').length;
  assert.ok(italicised > 20 && italicised < runs.length * 0.7, `${italicised}/200 letters italicised`);
});

test('a seed reproduces a letter exactly, so a good one can be regenerated', () => {
  const first = createCoverLetterVariation();
  const again = createCoverLetterVariation(first.seed);

  assert.deepEqual(again, first);
  assert.notDeepEqual(createCoverLetterVariation(first.seed + 1).recipe, first.recipe);
});
