const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { uniqueCaseInsensitive } = require('../dist/utils/array');
const { extractJSON, extractJsonObject } = require('../dist/utils/json');
const { removeDuplicateSubstrings } = require('../dist/services/utils/resumeBuilder');
const { isSafeId } = require('../dist/utils/safeId');
const {
  buildGeneratedArtifactFilename,
} = require('../dist/utils/generatedPath');
const {
  buildOutputPathPreview,
  normalizeOutputBaseDir,
  normalizeOutputPathTemplate,
  outputPathTemplateUsesJobTitle,
  renderOutputPathTemplate,
  resolveStoredFilePath,
  sanitizePathSegment,
  validateOutputPathTemplate,
} = require('../dist/utils/outputStorage');

test('uniqueCaseInsensitive keeps the first item for each lowercase key', () => {
  assert.deepEqual(
    uniqueCaseInsensitive(['React', 'react', 'Node.js', 'NODE.JS', 'TypeScript']),
    ['React', 'Node.js', 'TypeScript']
  );
});


test('extractJSON reads direct JSON, fenced JSON, and balanced JSON inside text', () => {
  assert.equal(extractJSON('{"ok":true}'), '{"ok":true}');
  assert.equal(extractJSON('```json\n{"ok":true}\n```'), '{"ok":true}');
  assert.equal(extractJSON('prefix {"items":[{"name":"A"}]} suffix'), '{"items":[{"name":"A"}]}');
  assert.equal(extractJSON('answer: ["a", "b"]'), '["a", "b"]');
});

test('extractJSON throws when no parseable JSON exists', () => {
  assert.throws(() => extractJSON('not json'), /No valid JSON object/);
});

test('output path helpers normalize, render, and validate paths', () => {
  assert.equal(sanitizePathSegment(' Senior Engineer / Platform '), 'senior_engineer_platform');
  assert.equal(normalizeOutputPathTemplate('profile\\{{date}}//{{company}}/'), '/profile/{{date}}/{{company}}');
  assert.equal(validateOutputPathTemplate('/{{profile name}}/{{role}}'), '/{{profile name}}/{{role}}');
  assert.throws(() => validateOutputPathTemplate('/{{unknown}}'), /Unsupported output path token/);

  assert.equal(
    renderOutputPathTemplate('/{{profile name}}/{{company name}}/{{job title}}', {
      date: '2026-04-18',
      profileName: 'Jane Doe',
      companyName: 'Acme Inc.',
      jobTitle: 'Senior Engineer',
    }),
    'jane_doe/acme_inc/senior_engineer'
  );

  assert.equal(buildOutputPathPreview('/{{date}}/{{company name}}'), '/2026_04_10/acme_inc');
  assert.equal(outputPathTemplateUsesJobTitle('/{{role}}'), true);
  assert.equal(outputPathTemplateUsesJobTitle('/{{company name}}'), false);
});

test('resolveStoredFilePath keeps paths inside the configured base directory', () => {
  const base = path.join(process.cwd(), 'generated');

  assert.equal(normalizeOutputBaseDir(base), path.resolve(base));
  assert.equal(resolveStoredFilePath(base, 'jane/acme/resume.pdf'), path.join(base, 'jane', 'acme', 'resume.pdf'));
  assert.equal(resolveStoredFilePath(base, '../outside.pdf'), null);
  assert.equal(resolveStoredFilePath(base, ''), null);
});

test('generated artifact filenames include profile, type, and role in title dash case', () => {
  const pathInfo = {
    relativeBase: 'kyle_escobar/2026_05_10/square/senior_software_engineer',
    absoluteDir: '/tmp/generated/kyle_escobar/2026_05_10/square/senior_software_engineer',
    storagePathBase: 'kyle_escobar/2026_05_10/square/senior_software_engineer',
    profileSlug: 'kyle_escobar',
    companyFolderName: 'square',
    roleSlug: 'senior_software_engineer',
    profileFileSegment: 'Kyle-Escobar',
    companyFileSegment: 'Square',
    roleFileSegment: 'Senior-Software-Engineer',
  };

  assert.equal(
    buildGeneratedArtifactFilename(pathInfo, 'resume', 'pdf'),
    'Kyle-Escobar-Resume-Senior-Software-Engineer.pdf'
  );
  assert.equal(
    buildGeneratedArtifactFilename(pathInfo, 'coverletter', 'pdf'),
    'Kyle-Escobar-Cover-Letter-Senior-Software-Engineer.pdf'
  );
});

test('generated artifact filenames preserve common tech acronyms', () => {
  const pathInfo = {
    relativeBase: 'kyle_escobar/2026_05_10/square/senior_infrastructure_engineer_ai_ml_engineer',
    absoluteDir: '/tmp/generated/kyle_escobar/2026_05_10/square/senior_infrastructure_engineer_ai_ml_engineer',
    storagePathBase: 'kyle_escobar/2026_05_10/square/senior_infrastructure_engineer_ai_ml_engineer',
    profileSlug: 'kyle_escobar',
    companyFolderName: 'square',
    roleSlug: 'senior_infrastructure_engineer_ai_ml_engineer',
    profileFileSegment: 'Kyle-Escobar',
    companyFileSegment: 'Square',
    roleFileSegment: 'Senior-Infrastructure-Engineer-AI-ML-Engineer',
  };

  assert.equal(
    buildGeneratedArtifactFilename(pathInfo, 'resume', 'pdf'),
    'Kyle-Escobar-Resume-Senior-Infrastructure-Engineer-AI-ML-Engineer.pdf'
  );
  assert.equal(
    buildGeneratedArtifactFilename(pathInfo, 'coverletter', 'pdf'),
    'Kyle-Escobar-Cover-Letter-Senior-Infrastructure-Engineer-AI-ML-Engineer.pdf'
  );
});

test('extractJSON refuses to return a fragment when the reply is cut off mid-JSON', () => {
  // A tailor-resume reply truncated by an output cap: the outer object never closes, but
  // the experience entries inside it do. Returning one of those looks like a successful
  // parse while silently dropping summary/experience/strengths.
  const truncated = [
    '```json',
    '{',
    '  "title": "Senior Software Engineer",',
    '  "summary": "A long professional summary.",',
    '  "experience": [',
    '    {',
    '      "title": "Senior Software Engineer",',
    '      "company": "JPMorgan Chase & Co",',
    '      "achievements": ["Cut latency by 32%"]',
    '    },',
    '    {',
    '      "title": "Software Engineer",',
    '      "company": "Revat',
  ].join('\n');

  assert.throws(() => extractJSON(truncated), /ended mid-JSON/);
  assert.throws(() => extractJSON('{"a":{"b":1},"c":[{"d":2}'), /ended mid-JSON/);
});

test('extractJSON falls back to the unfenced text when a fence closes early', () => {
  // The payload itself contains a fence, so the lazy fence regex captures only part of
  // it; the complete unfenced text must still win.
  const payload = {
    summary: 'Use ```code``` blocks sparingly.',
    experience: [{ title: 'Engineer' }],
  };
  const text = '```json\n' + JSON.stringify(payload) + '\n```';

  const extracted = JSON.parse(extractJSON(text));
  assert.equal(extracted.summary, payload.summary);
  assert.equal(extracted.experience.length, 1);
});

test('removeDuplicateSubstrings only drops a skill another skill contains as whole words', () => {
  // Word-level containment: a keyword scan for the shorter term already hits the longer one.
  assert.deepEqual(removeDuplicateSubstrings(['microservices', 'microservices architecture']), ['microservices architecture']);
  assert.deepEqual(removeDuplicateSubstrings(['AWS', 'AWS Lambda', 'Amazon S3']), ['AWS Lambda', 'Amazon S3']);
  assert.deepEqual(removeDuplicateSubstrings(['C#', 'C#/.NET']), ['C#/.NET']);
  // Character-level containment is not the same term and must be kept.
  assert.deepEqual(removeDuplicateSubstrings(['SQL', 'NoSQL', 'PostgreSQL']), ['SQL', 'NoSQL', 'PostgreSQL']);
  assert.deepEqual(removeDuplicateSubstrings(['Go', 'MongoDB', 'Django']), ['Go', 'MongoDB', 'Django']);
  assert.deepEqual(removeDuplicateSubstrings(['Java', 'JavaScript']), ['Java', 'JavaScript']);
  assert.deepEqual(removeDuplicateSubstrings(['REST APIs', 'REST API design']), ['REST APIs', 'REST API design']);
});

test('isSafeId accepts the ids this app generates and rejects path tricks', () => {
  for (const ok of ['06213f74-a36d-4071-9a9d-5f59a7ef0a3e', 'default', 'custom-my-prompt-2', 'analyze-job-description', 'u-1a2b3c4d']) {
    assert.equal(isSafeId(ok), true, ok);
  }
  assert.equal(isSafeId('m/one-column-clean', { allowSlash: true }), true);
  assert.equal(isSafeId('m/one-column-clean'), false, 'a slash must be opted into');
  for (const bad of ['', '.', '..', '../config/ai-models', '..\\config', 'a/../b', 'm//x', '/etc', '.hidden', 'a b', 'x'.repeat(201), 42, null, undefined]) {
    assert.equal(isSafeId(bad, { allowSlash: true }), false, String(bad));
  }
});

test('extractJSON still skips prose that contains braces before the real payload', () => {
  assert.equal(extractJSON('I will use {curly braces} here: {"ok":true}'), '{"ok":true}');
});

test('extractJSON does not descend into a structure it could not parse', () => {
  // A complete reply whose outer object has a syntax error (an unescaped quote inside
  // coverLetter). The object balances but will not parse, while the experience array
  // inside it parses perfectly — returning that array would look like a success and
  // silently drop every other field.
  const malformed = [
    '```json',
    '{',
    '  "title": "Senior Software Engineer",',
    '  "experience": [',
    '    { "title": "Senior Software Engineer", "company": "JPMorgan Chase & Co" },',
    '    { "title": "Software Engineer", "company": "Revature" }',
    '  ],',
    '  "coverLetter": "I said "hello" to the team."',
    '}',
    '```',
  ].join('\n');

  assert.throws(() => extractJSON(malformed), /syntax error/);
});

test('extractJsonObject rejects a bare array returned instead of an object', () => {
  // Spreading an array into the tailored-resume shape yields {"0":...,"1":...} and loses
  // experience, summary and strengths, so this must fail loudly instead.
  assert.throws(
    () => extractJsonObject('[{"title":"Senior Software Engineer"}]', 'the tailored resume'),
    /Expected the tailored resume to be a JSON object but the model returned an array/
  );
  assert.throws(() => extractJsonObject('42', 'the job analysis'), /returned a number/);
  assert.deepEqual(extractJsonObject('{"ok":true}', 'the job analysis'), { ok: true });
});
