const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir, readJson } = require('./helpers');

function writePrompt(dataDir, id, content) {
  const promptsDir = path.join(dataDir, 'prompts');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(promptsDir, `${id}.json`),
    `${JSON.stringify({
      id,
      content,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    }, null, 2)}\n`
  );
}

test('prompt service lists and renders built-in JSON prompts', async () => {
  const dataDir = makeTempDataDir('prompts-built-in');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'analyze-job-description', 'Analyze [[jobDescription]]');

  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].id, 'analyze-job-description');
  assert.equal(prompts[0].isBuiltIn, true);
  assert.deepEqual(prompts[0].validation, {
    usedVariables: ['jobDescription'],
    unknownVariables: [],
  });

  assert.equal(
    await promptService.renderPrompt('analyze-job-description', { jobDescription: 'Backend role' }),
    'Analyze Backend role'
  );
});

test('prompt service creates, previews, updates, and deletes custom JSON prompts', async () => {
  const dataDir = makeTempDataDir('prompts-custom');
  process.env.TAILOR_DATA_DIR = dataDir;
  const promptService = loadFresh('../dist/services/promptService');

  const created = await promptService.createPrompt({
    name: 'Greeting Prompt',
    description: 'Simple greeting',
    content: 'Hello [[name]]',
    responseFormat: 'text',
    allowedVariables: [{ name: 'name', description: 'Recipient name', sampleValue: 'Jane' }],
  });

  assert.equal(created.id, 'custom-greeting-prompt');
  assert.equal(created.isBuiltIn, false);
  assert.equal(created.content, 'Hello [[name]]');
  assert.deepEqual(created.validation, { usedVariables: ['name'], unknownVariables: [] });

  const promptPath = path.join(dataDir, 'prompts', `${created.id}.json`);
  assert.equal(readJson(promptPath).content, 'Hello [[name]]');

  const preview = await promptService.previewPrompt({
    id: created.id,
    sampleValues: { name: 'Ada' },
  });
  assert.equal(preview.renderedContent, 'Hello Ada');

  assert.equal(await promptService.renderPrompt(created.id, { name: 'Grace' }), 'Hello Grace');

  const updated = await promptService.updatePrompt(created.id, {
    name: 'Greeting Prompt Updated',
    content: 'Hi [[name]]',
    responseFormat: 'text',
    allowedVariables: [{ name: 'name' }],
  });

  assert.equal(updated.name, 'Greeting Prompt Updated');
  assert.equal(updated.content, 'Hi [[name]]');

  assert.equal(await promptService.deletePrompt(created.id), true);
  assert.equal(await promptService.getPromptById(created.id), null);
  assert.equal(fs.existsSync(promptPath), false);
});

test('prompt validation rejects unknown variables', async () => {
  const dataDir = makeTempDataDir('prompts-validation');
  process.env.TAILOR_DATA_DIR = dataDir;
  const promptService = loadFresh('../dist/services/promptService');

  assert.deepEqual(promptService.extractPromptVariables('[[one]] and [[ two ]] and [[one]]'), ['one', 'two']);
  const validation = promptService.validatePromptContent('Hello [[missing]]', [{ name: 'name' }]);
  assert.deepEqual(validation, {
    usedVariables: ['missing'],
    unknownVariables: ['missing'],
  });

  await assert.rejects(
    () => promptService.createPrompt({
      name: 'Invalid Prompt',
      content: 'Hello [[missing]]',
      allowedVariables: [{ name: 'name' }],
    }),
    /Unknown prompt variables/
  );
});

test('renderPromptSegments splits a prompt at each cache tier, most stable first', async (t) => {
  const dataDir = makeTempDataDir('prompts-segments');
  process.env.TAILOR_DATA_DIR = dataDir;
  writePrompt(dataDir, 'tailor-resume', 'RULES [[hardSkillsJSON]] MID [[profileJson]] END');
  const promptService = loadFresh('../dist/services/promptService');
  t.mock.method(console, 'warn', () => {});

  const values = { hardSkillsJSON: 'H', profileJson: 'P' };
  const segments = await promptService.renderPromptSegments('tailor-resume', values, [['hardSkillsJSON'], ['profileJson']]);
  assert.deepEqual(segments, [
    { text: 'RULES ', cache: true },
    { text: 'H MID ', cache: true },
    { text: 'P END' },
  ]);
  assert.equal(segments.map((s) => s.text).join(''), await promptService.renderPrompt('tailor-resume', values));
  assert.equal(console.warn.mock.callCount(), 0);

  // A tier that appears before a more stable one cannot be split off: it folds into the
  // previous chunk and the template is named so the ordering can be fixed.
  writePrompt(dataDir, 'tailor-resume', 'X [[profileJson]] Y [[hardSkillsJSON]] Z');
  const unordered = await promptService.renderPromptSegments('tailor-resume', values, [['hardSkillsJSON'], ['profileJson']]);
  assert.deepEqual(unordered, [{ text: 'X P Y ', cache: true }, { text: 'H Z' }]);
  assert.equal(console.warn.mock.callCount(), 1);
  assert.match(console.warn.mock.calls[0].arguments[0], /Prompt "tailor-resume": profileJson cannot be cached separately/);

  await assert.rejects(
    () => promptService.renderPromptSegments('tailor-resume', { profileJson: 'P' }, [['hardSkillsJSON'], ['profileJson']]),
    /missing runtime values for: hardSkillsJSON/
  );
});

test('the shipped tailor-resume prompt is ordered for caching: rules, then job, then profile', async () => {
  const dataDir = makeTempDataDir('prompts-shipped');
  process.env.TAILOR_DATA_DIR = dataDir;
  const shipped = readJson(path.join(__dirname, '..', 'data', 'prompts', 'tailor-resume.json'));
  writePrompt(dataDir, 'tailor-resume', shipped.content);
  const promptService = loadFresh('../dist/services/promptService');

  const values = {
    profileJson: '{"name":"Jane"}', jobAnalysisJson: '{"jobMeta":{}}', hardSkillsJSON: '["Go"]',
    keywordsJson: '["ship"]', keyResponsibilitiesJson: '["build"]', domainKnowledge: '["fintech"]', softSkillsJSON: '["clarity"]',
    actionVerbPool: 'Automated, Provisioned', certificationsJson: '["CKA"]', acronymPairsJson: '[{"long":"Infrastructure as Code","short":"IaC"}]',
    coverLetterRecipe: 'Exactly 2 paragraphs.',
  };
  const tiers = [
    ['jobAnalysisJson', 'hardSkillsJSON', 'keywordsJson', 'keyResponsibilitiesJson', 'domainKnowledge', 'softSkillsJSON', 'actionVerbPool', 'certificationsJson', 'acronymPairsJson'],
    ['profileJson'],
  ];
  const segments = await promptService.renderPromptSegments('tailor-resume', values, tiers);
  const total = segments.reduce((n, s) => n + s.text.length, 0);

  assert.equal(segments.length, 3, 'rules | job block | profile');
  assert.deepEqual(segments.map((s) => s.cache), [true, true, undefined]);
  assert.ok(segments[0].text.length / total > 0.7, 'rules prefix is ' + Math.round(segments[0].text.length / total * 100) + '% of the prompt');
  assert.ok(segments[0].text.includes('Return ONLY a valid JSON object'), 'the OUTPUT schema is part of the cached rules');
  assert.ok(segments[1].text.includes('{"jobMeta":{}}') && segments[1].text.includes('["Go"]'));
  // The verb pool, the posting's certifications and its acronym pairs depend on the posting only, so they cache with the job block.
  assert.ok(segments[1].text.includes('Automated, Provisioned') && segments[1].text.includes('["CKA"]') && segments[1].text.includes('"short":"IaC"'), 'family-dependent values sit in the job block');
  assert.ok(!segments[0].text.includes('Engineered, Architected'), 'the engineering verb pool is no longer hard-coded in the rules');
  assert.ok(segments[2].text.includes('{"name":"Jane"}'));
  // The per-letter brief is redrawn every call, so it has to sit in the uncached tail.
  assert.ok(segments[2].text.includes('Exactly 2 paragraphs.'), 'the recipe belongs in the volatile segment');
  assert.ok(!segments[0].text.includes('Exactly 2 paragraphs.') && !segments[1].text.includes('Exactly 2 paragraphs.'));
  // The stems that gave every letter the same skeleton are gone.
  for (const stem of ['In my role at X, I...', 'Para 1:', 'Para 4 (optional):']) {
    assert.ok(!shipped.content.includes(stem), stem + ' is still prescribed');
  }
  // The skills section is assembled in code after the call; the model only adds what the profile evidences.
  assert.ok(!shipped.content.includes('Minimum 30 items') && shipped.content.includes('up to 15 hard skills'), 'the model no longer writes the 30-item skills list');
  // A posting the profile cannot honestly match must still come back as JSON, never as a prose refusal.
  assert.ok(shipped.content.includes('never a prose explanation or a refusal'), 'the no-refusal rule is in the shipped prompt');
});

test('the shipped prompt asks for an experience index, not a copy of the profile', () => {
  const shipped = readJson(path.join(__dirname, '..', 'data', 'prompts', 'tailor-resume.json'));

  // The JSON schema block, from "experience" to the array that closes it.
  const schema = /"experience":\s*\[[\s\S]*?\]\s*,/.exec(shipped.content);
  assert.ok(schema, 'the output schema still declares an experience array');

  assert.match(schema[0], /"index":\s*number/, 'the model must point at a profile role');
  assert.match(schema[0], /"description":\s*string/);
  assert.match(schema[0], /"achievements":\s*string\[\]/);

  // These are facts the backend merges in. Asking for them back costs output tokens at the
  // most expensive rate in the call and lets the model drift on an employer or a date.
  for (const field of ['title', 'company', 'startDate', 'endDate', 'location']) {
    assert.ok(!schema[0].includes(`"${field}"`), `the schema still asks the model to echo ${field}`);
  }

  // Every bullet-count rule is written against "most recent first", so the index has to be
  // pinned to that order or the caps land on the wrong roles.
  assert.match(shipped.content, /Index 0 is the most recent role/);
  assert.match(shipped.content, /ascending index order/);
});

// The prompt files that ship in data/prompts are what every build renders. A variable
// added to one of them but never registered in BUILT_IN_PROMPTS makes loadRenderablePrompt
// throw, which took down every tailored build until it was noticed by hand.
test('every shipped prompt file uses only variables the prompt service declares', async () => {
  delete process.env.TAILOR_DATA_DIR;
  const promptService = loadFresh('../dist/services/promptService');
  const prompts = await promptService.listPrompts();

  assert.ok(prompts.length > 0, 'data/prompts is not empty');
  for (const prompt of prompts) {
    assert.deepEqual(
      prompt.validation.unknownVariables,
      [],
      `prompt "${prompt.id}" uses undeclared variables: ${prompt.validation.unknownVariables.join(', ')}`
    );
  }
});
