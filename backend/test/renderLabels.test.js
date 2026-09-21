const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Handlebars = require('handlebars');

const { loadFresh, makeTempDataDir } = require('./helpers');

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');
const templateFiles = [
  path.join(TEMPLATES_DIR, 'default.json'),
  ...fs
    .readdirSync(path.join(TEMPLATES_DIR, 'm'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(TEMPLATES_DIR, 'm', file)),
];
const readTemplate = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const renderTemplate = (file, data) => Handlebars.compile(readTemplate(file).htmlContent)(data);

const LABEL_PLACEHOLDERS = ['{{labels.strengths}}', '{{labels.hardSkills}}', '{{labels.softSkills}}', '{{labels.certifications}}'];
const LITERAL_HEADINGS = ['>Hard Skills<', '>Soft Skills<', '>Strengths<'];

// A nursing posting: every heading differs from the engineering defaults, so a default leaking through is visible.
const nursingLabels = {
  hardSkills: 'Clinical Skills',
  softSkills: 'Interpersonal Skills',
  strengths: 'Core Competencies',
  certifications: 'Licenses and Certifications',
};
const certification = { name: 'Registered Nurse (RN)', issuer: 'State Board of Nursing', date: '2019', expiryDate: '2027' };

const profile = {
  id: 'p1',
  name: 'Jane Smith',
  title: 'Senior Software Engineer',
  contact: { phone: '+1 555 0100', email: 'jane@example.com', linkedin: 'linkedin.com/in/jane', location: 'Boston, MA' },
  summary: 'Profile summary.',
  experience: [
    {
      title: 'Staff Nurse',
      company: 'General Hospital',
      startDate: '2019',
      endDate: 'Present',
      location: 'Boston, MA',
      description: 'ICU nursing.',
      achievements: ['Cut readmissions 12%'],
    },
  ],
  strengths: [{ title: 'Triage', description: 'Fast, calm assessment.' }],
  skills: ['Patient Assessment', 'Medication Administration'],
  education: [{ degree: 'BSN', institution: 'State University', startDate: '2015', endDate: '2019', location: 'Boston, MA' }],
  certifications: [certification],
  createdAt: '',
  updatedAt: '',
};
const tailored = {
  title: 'Registered Nurse',
  summary: 'Tailored summary.',
  experience: profile.experience,
  skills: ['Patient Assessment'],
  hardSkills: ['Patient Assessment', 'Triage Protocols'],
  softSkills: ['Communication', 'Empathy'],
  unconfirmedSoftSkills: [],
  unconfirmedHardSkills: [],
  strengths: profile.strengths,
  sectionLabels: nursingLabels,
  jobFamily: 'healthcare',
};

test('every shipped template renders its headings from labels and lists certifications', () => {
  assert.equal(templateFiles.length, 17);
  for (const file of templateFiles) {
    const name = path.basename(file);
    const template = readTemplate(file);
    for (const placeholder of LABEL_PLACEHOLDERS) {
      assert.ok(template.htmlContent.includes(placeholder), `${name} lacks ${placeholder}`);
    }
    for (const heading of LITERAL_HEADINGS) {
      assert.ok(!template.htmlContent.includes(heading), `${name} still has the literal ${heading}`);
    }
    assert.ok(template.sections.includes('certifications'), `${name} does not list certifications in sections`);
  }
});

test('a template compiled with render data shows the family labels and a certification', () => {
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const data = prepareResumeRenderData(profile, tailored);
  for (const file of templateFiles) {
    const name = path.basename(file);
    const html = renderTemplate(file, data);
    for (const label of Object.values(nursingLabels)) {
      assert.ok(html.includes(label), `${name} does not render ${label}`);
    }
    assert.ok(
      html.includes('Registered Nurse (RN)') && html.includes('State Board of Nursing') && html.includes('2019 - 2027'),
      `${name} does not render the certification`
    );
  }

  const untailored = renderTemplate(templateFiles[0], prepareResumeRenderData({ ...profile, certifications: [] }));
  assert.ok(untailored.includes('>Hard Skills<') && untailored.includes('>Strengths<'), 'defaults render without tailoring');
  assert.ok(!untailored.includes('Certifications'), 'no certifications heading without certifications');
});

test('prepareResumeRenderData prefers the tailored headline and keeps symbols that belong to a token', () => {
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  assert.equal(prepareResumeRenderData(profile, tailored).title, 'Registered Nurse');
  assert.equal(prepareResumeRenderData(profile).title, 'Senior Software Engineer', 'untailored keeps the profile title');
  assert.equal(prepareResumeRenderData({ ...profile, title: '' }).title, 'Staff Nurse', 'then the latest role');

  const titled = (title) => prepareResumeRenderData(profile, { ...tailored, title }).title;
  assert.equal(titled('C++ Developer'), 'C++ Developer');
  assert.equal(titled('C# Developer'), 'C# Developer');
  assert.equal(titled('UI/UX Designer'), 'UI/UX Designer');
  assert.equal(titled('.NET Developer'), '.NET Developer');
  assert.equal(titled('FP&A Manager'), 'FP&A Manager');
  assert.equal(titled('Front-End Developer'), 'Front-End Developer');
  assert.equal(titled('Manager, Data Platform'), 'Manager Data Platform', 'a comma reads as a field separator');
  assert.equal(titled('Senior Engineer (Backend) - Remote'), 'Senior Engineer Backend Remote', 'brackets and spaced dashes go');
  assert.equal(titled('   '), 'Senior Software Engineer', 'a blank tailored title falls back to the profile');
});

test('section labels merge over the defaults and empty overrides fall back', () => {
  const { prepareResumeRenderData, resolveSectionLabels } = require('../dist/generators/pdfGenerator');
  const { DEFAULT_SECTION_LABELS } = require('../dist/services/jobFamilies/types');

  assert.deepEqual(prepareResumeRenderData(profile).labels, DEFAULT_SECTION_LABELS);
  assert.deepEqual(prepareResumeRenderData(profile, tailored).labels, nursingLabels);
  assert.deepEqual(
    prepareResumeRenderData(profile, { ...tailored, sectionLabels: { hardSkills: 'Sales Skills' } }).labels,
    { ...DEFAULT_SECTION_LABELS, hardSkills: 'Sales Skills' },
    'a partial object keeps the other defaults'
  );
  assert.equal(
    prepareResumeRenderData(profile, { ...tailored, sectionLabels: { hardSkills: '' } }).labels.hardSkills,
    'Hard Skills',
    'an empty string does not blank the heading'
  );
  assert.deepEqual(
    resolveSectionLabels({ hardSkills: '  ', softSkills: null, strengths: 7, certifications: ' Licenses ' }),
    { ...DEFAULT_SECTION_LABELS, certifications: 'Licenses' }
  );
  assert.deepEqual(resolveSectionLabels(null), DEFAULT_SECTION_LABELS);
  assert.deepEqual(resolveSectionLabels(undefined), DEFAULT_SECTION_LABELS);
});

test('certifications default to an empty array', () => {
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { certifications, ...withoutCertifications } = profile;
  assert.ok(certifications.length > 0);
  assert.deepEqual(prepareResumeRenderData(withoutCertifications).certifications, []);
  assert.deepEqual(prepareResumeRenderData(profile, tailored).certifications, [certification]);
});

test('the DOCX HTML carries the labels, hard skills only under the skills heading, and the certification', () => {
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildHayatoStyleHTML } = require('../dist/generators/docxGenerator');

  const html = buildHayatoStyleHTML(prepareResumeRenderData(profile, tailored));
  for (const label of Object.values(nursingLabels)) {
    assert.ok(html.includes(`<u>${label}</u>`), `missing heading ${label}`);
  }
  assert.ok(html.includes('<u>Professional Summary</u>') && html.includes('<u>Professional Experience</u>'));
  assert.ok(!html.includes('Key Strengths') && !html.includes('Technical Skills'));

  const hardIdx = html.indexOf('<u>Clinical Skills</u>');
  const softIdx = html.indexOf('<u>Interpersonal Skills</u>');
  assert.ok(hardIdx >= 0 && softIdx > hardIdx, 'soft skills follow hard skills');
  const hardParagraph = html.slice(hardIdx, softIdx);
  assert.ok(hardParagraph.includes('Patient Assessment, Triage Protocols'));
  assert.ok(!hardParagraph.includes('Communication'), 'soft skills are not mixed into the hard skills line');
  assert.ok(html.slice(softIdx).includes('Communication, Empathy'));

  const eduIdx = html.indexOf('<u>Education</u>');
  const certIdx = html.indexOf('<u>Licenses and Certifications</u>');
  assert.ok(eduIdx >= 0 && certIdx > eduIdx, 'certifications follow education');
  const certSection = html.slice(certIdx);
  assert.ok(certSection.includes('Registered Nurse (RN)') && certSection.includes('State Board of Nursing'));
  assert.ok(certSection.includes('2019 – 2027'), 'date and expiry form the range');

  const plain = buildHayatoStyleHTML(prepareResumeRenderData({ ...profile, certifications: [] }));
  assert.ok(plain.includes('<u>Strengths</u>') && plain.includes('<u>Hard Skills</u>'));
  assert.ok(!plain.includes('<u>Soft Skills</u>'), 'no soft skills heading without soft skills');
  assert.ok(!plain.includes('<u>Certifications</u>'), 'no certifications heading without certifications');
});

test('the built-in default template and the manual builder carry the labels and a certifications block', async () => {
  const dataDir = makeTempDataDir('templates');
  process.env.TAILOR_DATA_DIR = dataDir;
  const extractor = loadFresh('../dist/extractors/templateExtractor');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');

  assert.deepEqual(extractor.MANUAL_SECTIONS, [
    'summary', 'experience', 'strengths', 'hardSkills', 'softSkills', 'education', 'certifications',
  ]);

  const base = { name: 'Manual', accentColor: '#1e40af', bodyColor: '#000', bodyFontSizePt: 9, titleFontSizePt: 24 };
  const variants = {
    default: extractor.buildDefaultTemplateHTML(),
    oneColumn: extractor.buildManualTemplateHTML({ ...base, columns: 1 }),
    // No rightSectionOrder: the default right column must reach the certifications block.
    twoColumn: extractor.buildManualTemplateHTML({ ...base, columns: 2 }),
  };
  const data = prepareResumeRenderData(profile, tailored);
  for (const [name, html] of Object.entries(variants)) {
    for (const placeholder of LABEL_PLACEHOLDERS) {
      assert.ok(html.includes(placeholder), `${name} lacks ${placeholder}`);
    }
    assert.ok(html.includes('data-section="certifications"'), `${name} lacks the certifications block`);
    const rendered = Handlebars.compile(html)(data);
    for (const label of Object.values(nursingLabels)) {
      assert.ok(rendered.includes(label), `${name} does not render ${label}`);
    }
    assert.ok(rendered.includes('State Board of Nursing'), `${name} does not render the certification`);
  }

  const custom = extractor.buildManualTemplateHTML({ ...base, columns: 2, rightSectionOrder: ['education'] });
  assert.ok(!custom.includes('data-section="certifications"'), 'an explicit column order is respected');

  const created = await extractor.createDefaultTemplate();
  assert.ok(created.sections.includes('certifications'));
  const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'templates', 'default.json'), 'utf8'));
  assert.equal(written.htmlContent, variants.default);
  assert.deepEqual(written.sections, extractor.MANUAL_SECTIONS);
});
