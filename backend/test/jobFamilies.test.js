const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

const {
  DEFAULT_SECTION_LABELS,
  GENERIC_FAMILY,
  GENERIC_ROLE_WORDS,
  JOB_FAMILIES,
  SENIORITY_FORMS,
  buildHeadline,
  getJobFamily,
  isRoleTerm,
  matchesPhrase,
  resolveJobFamily,
  scoreJobFamily,
} = loadFresh('../dist/services/jobFamilies');

const context = (title, department = '', industry = '') => ({ title, department, industry });
const family = (id) => {
  const found = getJobFamily(id);
  assert.ok(found, `family ${id} exists`);
  return found;
};

// ---------------------------------------------------------------- registry integrity

test('every family has a unique id, a dozen distinct verbs, four headings, a known emphasis', () => {
  const ids = JOB_FAMILIES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const entry of JOB_FAMILIES) {
    assert.ok(entry.label.trim(), `${entry.id} has a label`);
    const verbs = new Set(entry.verbPool);
    assert.ok(verbs.size >= 12, `${entry.id} has ${verbs.size} distinct verbs`);
    for (const verb of entry.verbPool) assert.match(verb, /^[A-Z][a-z]+$/, `${entry.id} verb "${verb}" is one capitalised word`);
    for (const key of ['hardSkills', 'softSkills', 'strengths', 'certifications']) {
      assert.ok(typeof entry.sectionLabels[key] === 'string' && entry.sectionLabels[key].trim(), `${entry.id} label ${key}`);
    }
    assert.ok(['high', 'normal'].includes(entry.certificationEmphasis), `${entry.id} emphasis`);
    for (const dimension of ['titles', 'departments', 'industries']) {
      for (const phrase of entry.match[dimension]) assert.equal(phrase, phrase.toLowerCase(), `${entry.id} phrase "${phrase}" is lower-case`);
    }
    for (const word of entry.roleWords ?? []) assert.equal(word, word.toLowerCase(), `${entry.id} role word "${word}" is lower-case`);
    const placeholders = [...entry.headline.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
    assert.ok(placeholders.length > 0, `${entry.id} headline has a placeholder`);
    for (const key of placeholders) assert.ok(['title', 'seniority', 'domain'].includes(key), `${entry.id} placeholder {${key}}`);
  }
});

test('the generic family is last, has no match phrases and is what getJobFamily returns for it', () => {
  assert.equal(JOB_FAMILIES[JOB_FAMILIES.length - 1], GENERIC_FAMILY);
  assert.equal(GENERIC_FAMILY.id, 'generic');
  assert.deepEqual(GENERIC_FAMILY.match, { titles: [], departments: [], industries: [] });
  assert.equal(getJobFamily('generic'), GENERIC_FAMILY);
  assert.equal(getJobFamily('healthcare').id, 'healthcare');
  assert.equal(getJobFamily('no-such-family'), undefined);
});

test('the required families exist and carry the agreed headings and emphasis', () => {
  const required = [
    'devops-sre', 'software-engineering', 'data', 'qa-testing', 'product-management', 'design', 'it-support',
    'sales', 'marketing', 'finance-accounting', 'healthcare', 'human-resources', 'operations-project',
    'customer-success', 'education', 'legal', 'generic',
  ];
  assert.deepEqual(JOB_FAMILIES.map((entry) => entry.id), required, 'devops-sre precedes software-engineering; generic is last');
  assert.equal(family('devops-sre').sectionLabels.hardSkills, 'Technical Skills');
  assert.equal(family('software-engineering').sectionLabels.hardSkills, 'Technical Skills');
  assert.equal(family('finance-accounting').sectionLabels.hardSkills, 'Technical Skills');
  assert.equal(family('healthcare').sectionLabels.hardSkills, 'Clinical Skills');
  assert.equal(family('healthcare').sectionLabels.certifications, 'Licenses & Certifications');
  assert.equal(family('sales').sectionLabels.hardSkills, 'Sales Skills');
  assert.deepEqual(GENERIC_FAMILY.sectionLabels, { ...DEFAULT_SECTION_LABELS, hardSkills: 'Skills' });
  const high = JOB_FAMILIES.filter((entry) => entry.certificationEmphasis === 'high').map((entry) => entry.id).sort();
  assert.deepEqual(high, ['devops-sre', 'finance-accounting', 'healthcare', 'it-support', 'legal', 'operations-project']);
  assert.ok(!family('software-engineering').match.titles.includes('engineer'), 'software-engineering has no bare "engineer" phrase');
});

test('GENERIC_ROLE_WORDS is built once from nouns, level words and the seniority map', () => {
  assert.equal(new Set(GENERIC_ROLE_WORDS).size, GENERIC_ROLE_WORDS.length, 'no duplicate role words');
  for (const key of Object.keys(SENIORITY_FORMS)) assert.ok(GENERIC_ROLE_WORDS.includes(key), `seniority key "${key}" is a role word`);
  for (const word of ['engineer', 'nurse', 'software', 'registered', 'full-stack', 'mid', 'iii', 'sr', 'sr.', 'associate']) {
    assert.ok(GENERIC_ROLE_WORDS.includes(word), `"${word}" is a generic role word`);
  }
  assert.equal(SENIORITY_FORMS['sr.'], 'Senior');
  assert.equal(SENIORITY_FORMS.jr, 'Junior');
});

// ---------------------------------------------------------------- resolution

test('resolution picks the family from the posting title', () => {
  const cases = [
    ['DevOps Engineer III (Remote)', 'devops-sre'],
    ['Senior Site Reliability Engineer (SRE)', 'devops-sre'],
    ['SRE', 'devops-sre'],
    ['Backend Engineer', 'software-engineering'],
    ['Back-End Developer', 'software-engineering'],
    ['C++ Developer', 'software-engineering'],
    ['iOS Developer', 'software-engineering'],
    ['Data Engineer', 'data'],
    ['BI Developer', 'data'],
    ['Registered Nurse (RN) - ICU - Nights', 'healthcare'],
    ['Account Executive, Mid-Market', 'sales'],
    ['Staff Accountant', 'finance-accounting'],
    ['QA Engineer', 'qa-testing'],
    ['Software Engineer in Test', 'qa-testing'],
    ['Product Marketing Manager', 'marketing'],
    ['Instructional Designer', 'education'],
    ['Scrum Master', 'operations-project'],
    ['HR Business Partner', 'human-resources'],
    ['Paralegal', 'legal'],
    ['Customer Success Manager', 'customer-success'],
    ['Help Desk Technician', 'it-support'],
    ['Product Designer', 'design'],
    ['Senior Product Manager', 'product-management'],
    ['Underwater Basket Weaver', 'generic'],
    ['', 'generic'],
  ];
  for (const [title, expected] of cases) {
    assert.equal(resolveJobFamily(context(title)).id, expected, `"${title}"`);
  }
});

test('phrases match on whole words even when they start or end in symbols', () => {
  assert.equal(resolveJobFamily(context('presre')).id, 'generic', '"sre" does not match "presre"');
  assert.ok(matchesPhrase('Senior C++ Developer', 'c++'));
  assert.ok(!matchesPhrase('C+ Developer', 'c++'));
  assert.ok(matchesPhrase('Back-End Developer', 'back-end'));
  assert.ok(matchesPhrase('.NET Developer', '.net'));
  assert.ok(!matchesPhrase('devops2', 'devops'), 'a digit is part of the word');
  assert.ok(matchesPhrase('Site Reliability Engineer (SRE)', 'sre'));
  assert.ok(!matchesPhrase('Presrelease', 'sre'));
  assert.ok(matchesPhrase('FP&A Analyst', 'fp&a'));
});

test('a department alone resolves; generic department words go to software engineering, not devops', () => {
  assert.equal(resolveJobFamily(context('', 'Engineering')).id, 'software-engineering');
  assert.equal(resolveJobFamily(context('', 'Nursing')).id, 'healthcare');
  assert.equal(resolveJobFamily(context('', 'Platform Engineering')).id, 'devops-sre');
  assert.equal(resolveJobFamily(context('', '', 'Healthcare')).id, 'healthcare', 'an industry alone still counts');
});

test('weights: a title phrase beats a department phrase beats an industry phrase', () => {
  assert.equal(resolveJobFamily(context('Software Engineer', '', 'Healthcare')).id, 'software-engineering');
  assert.equal(resolveJobFamily(context('Machine Learning Engineer', 'Engineering')).id, 'data');
  assert.equal(resolveJobFamily(context('', 'Nursing', 'Software')).id, 'healthcare');
  const ctx = context('Registered Nurse', 'Nursing', 'Healthcare');
  assert.equal(scoreJobFamily(family('healthcare'), ctx), 3 * 2 + 2 + 1, 'registered nurse + nurse, nursing, healthcare');
});

test('an exact tie is broken by registry order', () => {
  const ctx = context('Software Engineer - Infrastructure');
  const devops = scoreJobFamily(family('devops-sre'), ctx);
  const software = scoreJobFamily(family('software-engineering'), ctx);
  assert.ok(devops > 0 && devops === software, `tie at ${devops}`);
  assert.equal(resolveJobFamily(ctx).id, 'devops-sre');
});

test('missing context fields are tolerated', () => {
  assert.equal(resolveJobFamily({ title: 'DevOps Engineer' }).id, 'devops-sre');
  assert.equal(resolveJobFamily({ title: undefined, department: undefined, industry: undefined }).id, 'generic');
});

// ---------------------------------------------------------------- headline

const seniorEngineer = { title: 'Senior Software Engineer' };

test('headline examples from the spec', () => {
  assert.equal(buildHeadline(family('devops-sre'), context('DevOps Engineer III (Remote)'), seniorEngineer), 'Senior DevOps Engineer');
  assert.equal(buildHeadline(family('devops-sre'), context('Senior Site Reliability Engineer (SRE)'), seniorEngineer), 'Senior Site Reliability Engineer');
  assert.equal(
    buildHeadline(family('healthcare'), context('Registered Nurse (RN) - ICU - Nights'), seniorEngineer),
    'Registered Nurse',
    'the healthcare pattern has no {seniority}, so nothing is borrowed from an engineering profile'
  );
  assert.equal(buildHeadline(family('sales'), context('Account Executive, Mid-Market'), { title: 'Account Executive' }), 'Account Executive');
  assert.equal(buildHeadline(GENERIC_FAMILY, context(''), { title: 'Product Designer' }), 'Product Designer');
});

test('an empty or note-only posting title falls back to the profile and never invents a headline', () => {
  assert.equal(buildHeadline(GENERIC_FAMILY, context(''), { title: '  ', experience: [{ title: 'Ops Lead' }] }), 'Ops Lead');
  assert.equal(buildHeadline(GENERIC_FAMILY, context(''), {}), '');
  assert.equal(buildHeadline(GENERIC_FAMILY, context('   '), { title: 'Teacher' }), 'Teacher');
  assert.equal(buildHeadline(GENERIC_FAMILY, context('Remote (Contract)'), { title: 'Teacher' }), 'Teacher');
  assert.equal(buildHeadline(family('software-engineering'), context('Software Engineer'), {}), 'Software Engineer');
});

test('seniority is one map: Sr. renders as Senior and is not doubled', () => {
  assert.equal(buildHeadline(family('devops-sre'), context('Sr. DevOps Engineer'), seniorEngineer), 'Senior DevOps Engineer');
  assert.equal(buildHeadline(family('devops-sre'), context('Jr DevOps Engineer'), seniorEngineer), 'Junior DevOps Engineer');
  assert.equal(buildHeadline(family('sales'), context('Head of Sales'), seniorEngineer), 'Head of Sales');
  assert.equal(buildHeadline(family('marketing'), context('Lead Generation Specialist'), seniorEngineer), 'Lead Generation Specialist');
});

test('seniority is borrowed only by families whose pattern asks for it, and only when the title has none', () => {
  const software = family('software-engineering');
  assert.equal(buildHeadline(software, context('Software Engineer'), { title: 'Lead Developer' }), 'Lead Software Engineer');
  assert.equal(
    buildHeadline(software, context('Software Engineer'), { title: 'Developer', experience: [{ title: 'Senior Engineer' }] }),
    'Senior Software Engineer',
    'the most recent experience title is the last source'
  );
  assert.equal(buildHeadline(software, context('Software Engineer'), { title: 'Developer' }), 'Software Engineer', 'nothing to borrow');
  assert.equal(buildHeadline(software, context('Software Engineer - Senior'), { title: 'Developer' }), 'Senior Software Engineer', 'a level in a dropped segment still counts');
  assert.equal(buildHeadline(family('sales'), context('Account Executive, Mid-Market'), { title: 'Senior Sales Manager' }), 'Senior Account Executive');
  for (const id of ['healthcare', 'legal', 'education', 'human-resources', 'customer-success', 'generic']) {
    assert.ok(!family(id).headline.includes('{seniority}'), `${id} does not borrow seniority`);
  }
  assert.equal(buildHeadline(family('legal'), context('Paralegal'), seniorEngineer), 'Paralegal');
  assert.equal(buildHeadline(family('human-resources'), context('HR Generalist - Remote'), seniorEngineer), 'HR Generalist');
});

test('title cleaning: segments, notes, parentheticals and levels', () => {
  const devops = family('devops-sre');
  assert.equal(buildHeadline(devops, context('Remote - Senior DevOps Engineer'), {}), 'Senior DevOps Engineer', 'a note-first segment empties out');
  assert.equal(buildHeadline(devops, context('DevOps Engineer | Remote | Contract'), {}), 'DevOps Engineer');
  assert.equal(buildHeadline(devops, context('Senior DevOps Engineer - New York, NY'), {}), 'Senior DevOps Engineer');
  assert.equal(buildHeadline(devops, context('Hybrid Senior DevOps Engineer II [Contract]'), {}), 'Senior DevOps Engineer');
  assert.equal(buildHeadline(devops, context('Senior DevOps Engineer (Remote, US) - Platform'), {}), 'Senior DevOps Engineer');
  assert.equal(buildHeadline(GENERIC_FAMILY, context('Manager, Data Platform'), {}), 'Manager', 'documented: only the first segment survives');
  assert.equal(buildHeadline(family('software-engineering'), context('Front-End Developer'), {}), 'Front-End Developer', 'an unspaced hyphen is not a separator');
});

test('casing keeps acronyms and inner capitals, title-cases the rest, lower-cases small words', () => {
  const devops = family('devops-sre');
  assert.equal(buildHeadline(devops, context('SENIOR DEVOPS ENGINEER'), {}), 'Senior Devops Engineer', 'a shouting title is title-cased (acronyms lost)');
  assert.equal(buildHeadline(devops, context('senior devops engineer'), {}), 'Senior Devops Engineer', 'a lowercase title has no acronym information either');
  assert.equal(buildHeadline(family('sales'), context('HEAD OF SALES'), {}), 'Head of Sales');
  assert.equal(buildHeadline(family('healthcare'), context('RN - ICU'), seniorEngineer), 'RN', 'a short all-caps title keeps its acronym');
  assert.equal(buildHeadline(family('qa-testing'), context('QA LEAD'), seniorEngineer), 'QA Lead');
  assert.equal(buildHeadline(family('software-engineering'), context('iOS developer'), seniorEngineer), 'Senior iOS Developer');
  assert.equal(buildHeadline(family('design'), context('UI/UX designer'), {}), 'UI/UX Designer');
  assert.equal(buildHeadline(family('software-engineering'), context('director of engineering'), {}), 'Director of Engineering');
  assert.equal(buildHeadline(family('software-engineering'), context('of counsel engineer'), {}), 'Of Counsel Engineer', 'a small word is capitalised when first');
});

test('{domain} is available to any family purely as data', () => {
  const domainFamily = { ...family('software-engineering'), headline: '{seniority} {domain} Engineer' };
  assert.equal(buildHeadline(domainFamily, context('Senior Site Reliability Engineer (SRE)'), {}), 'Senior Site Reliability Engineer');
  assert.equal(buildHeadline(domainFamily, context('DevOps Engineer III'), seniorEngineer), 'Senior DevOps Engineer');
  assert.equal(buildHeadline(domainFamily, context('Backend Developer'), {}), 'Engineer', 'role words leave the domain');
  assert.equal(buildHeadline({ ...GENERIC_FAMILY, headline: '{title} {unknown}' }, context('Teacher'), {}), 'Teacher', 'an unknown placeholder renders empty');
});

// ---------------------------------------------------------------- isRoleTerm

test('role terms are recognised in every family through the generic list', () => {
  for (const entry of JOB_FAMILIES) {
    assert.ok(isRoleTerm('Software Engineer', entry), `${entry.id}: Software Engineer`);
    assert.ok(isRoleTerm('Senior Developer', entry), `${entry.id}: Senior Developer`);
    assert.ok(isRoleTerm('Backend', entry), `${entry.id}: Backend`);
    assert.ok(isRoleTerm('Full Stack Developer', entry), `${entry.id}: Full Stack Developer`);
    assert.ok(isRoleTerm('Registered Nurse', entry), `${entry.id}: Registered Nurse`);
    assert.ok(isRoleTerm('Sr. Engineer', entry), `${entry.id}: Sr. Engineer`);
    assert.ok(!isRoleTerm('Backend development', entry), `${entry.id}: Backend development is a skill`);
    assert.ok(!isRoleTerm('Software architecture', entry), `${entry.id}: Software architecture is a skill`);
    assert.ok(!isRoleTerm('Patient education', entry), `${entry.id}: Patient education is a skill`);
    assert.ok(!isRoleTerm('C++', entry), `${entry.id}: C++ is a skill`);
    assert.ok(!isRoleTerm('Kubernetes', entry), `${entry.id}: Kubernetes is a skill`);
    assert.ok(!isRoleTerm('', entry), `${entry.id}: empty`);
    assert.ok(!isRoleTerm('of the', entry), `${entry.id}: connectives alone are nothing`);
  }
});

test('family role words are scoped to their family, connectives are ignored, phrases count whole', () => {
  const healthcare = family('healthcare');
  assert.ok(isRoleTerm('RN', healthcare));
  assert.ok(isRoleTerm('Nurse Practitioner', healthcare));
  assert.ok(isRoleTerm('Director of Nursing', healthcare));
  assert.ok(!isRoleTerm('RN', GENERIC_FAMILY), 'RN means nothing outside healthcare');
  assert.ok(isRoleTerm('Head of Sales', family('sales')));
  assert.ok(isRoleTerm('Account Executive', family('sales')));
  assert.ok(!isRoleTerm('Account management', family('sales')));
  assert.ok(isRoleTerm('VP of Engineering', family('software-engineering')));
  assert.ok(isRoleTerm('Software Engineer in Test', family('qa-testing')));
  assert.ok(isRoleTerm('Scrum Master', family('operations-project')), 'a phrase entry');
  assert.ok(!isRoleTerm('Scrum', family('operations-project')), 'the methodology stays a skill');
  assert.ok(isRoleTerm('CPA', family('finance-accounting')));
  assert.ok(isRoleTerm('Attorney', family('legal')));
  assert.ok(!isRoleTerm('Contract negotiation', family('legal')));
});
