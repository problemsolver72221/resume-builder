const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { makeTempDataDir } = require('./helpers');
const {
  buildGeneratedArtifactFilename,
  findExistingArtifacts,
  listExpectedArtifacts,
} = require('../dist/utils/generatedPath');

function pathInfoIn(absoluteDir) {
  return {
    relativeBase: 'kyle_escobar/2026_05_10/square/senior_software_engineer',
    absoluteDir,
    storagePathBase: 'kyle_escobar/2026_05_10/square/senior_software_engineer',
    profileSlug: 'kyle_escobar',
    companyFolderName: 'square',
    roleSlug: 'senior_software_engineer',
    profileFileSegment: 'Kyle-Escobar',
    companyFileSegment: 'Square',
    roleFileSegment: 'Senior-Software-Engineer',
  };
}

function writeArtifact(pathInfo, spec, content = 'x') {
  fs.mkdirSync(pathInfo.absoluteDir, { recursive: true });
  fs.writeFileSync(path.join(pathInfo.absoluteDir, buildGeneratedArtifactFilename(pathInfo, spec.kind, spec.extension)), content);
}

test('the expected artifact list follows the format and cover-letter options', () => {
  const keys = (options) => listExpectedArtifacts(options).map((spec) => spec.key);

  assert.deepEqual(keys({ format: 'both', coverLetter: true, coverLetterDocx: true }), [
    'resumePdf', 'resumeDocx', 'coverLetterPdf', 'coverLetterDocx',
  ]);
  assert.deepEqual(keys({ format: 'pdf', coverLetter: true, coverLetterDocx: false }), ['resumePdf', 'coverLetterPdf']);
  assert.deepEqual(keys({ format: 'docx', coverLetter: false, coverLetterDocx: true }), ['resumeDocx']);
  // A DOCX letter without a letter makes no sense and is not expected.
  assert.deepEqual(keys({ format: 'pdf', coverLetter: false, coverLetterDocx: true }), ['resumePdf']);
});

test('a build is "already done" only when every expected file is on disk and non-empty', async () => {
  const pathInfo = pathInfoIn(path.join(makeTempDataDir('artifacts'), 'out'));
  const specs = listExpectedArtifacts({ format: 'both', coverLetter: true, coverLetterDocx: false });

  assert.equal(await findExistingArtifacts(pathInfo, specs), null, 'nothing written yet');

  writeArtifact(pathInfo, specs[0]);
  writeArtifact(pathInfo, specs[1]);
  assert.equal(await findExistingArtifacts(pathInfo, specs), null, 'the letter is still missing');

  // An interrupted write leaves an empty file; that must not count as finished.
  writeArtifact(pathInfo, specs[2], '');
  assert.equal(await findExistingArtifacts(pathInfo, specs), null, 'an empty file is not a finished letter');

  writeArtifact(pathInfo, specs[2], '%PDF-1.4');
  assert.deepEqual(await findExistingArtifacts(pathInfo, specs), {
    resumePdf: 'kyle_escobar/2026_05_10/square/senior_software_engineer/Kyle-Escobar-Resume-Senior-Software-Engineer.pdf',
    resumeDocx: 'kyle_escobar/2026_05_10/square/senior_software_engineer/Kyle-Escobar-Resume-Senior-Software-Engineer.docx',
    coverLetterPdf: 'kyle_escobar/2026_05_10/square/senior_software_engineer/Kyle-Escobar-Cover-Letter-Senior-Software-Engineer.pdf',
  });

  // Turning the letter off afterwards narrows what "done" means, so the same folder still counts.
  const resumeOnly = listExpectedArtifacts({ format: 'both', coverLetter: false, coverLetterDocx: false });
  const found = await findExistingArtifacts(pathInfo, resumeOnly);
  assert.deepEqual(Object.keys(found), ['resumePdf', 'resumeDocx']);
});

test('an empty expectation never reports a build as done', async () => {
  const pathInfo = pathInfoIn(path.join(makeTempDataDir('artifacts-empty'), 'out'));
  assert.equal(await findExistingArtifacts(pathInfo, []), null);
});
