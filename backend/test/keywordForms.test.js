const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir } = require('./helpers');
const {
  indexKeywordForms,
  normalizeKeyword,
  keywordKey,
  sameKeyword,
  formsOf,
  pairedForm,
  pairAcronyms,
  relevantGroups,
  groupsFromPairs,
  groupsForFamily,
  mergeKeywordFormGroups,
  sanitizeKeywordFormGroup,
} = require('../dist/services/utils/keywordForms');

const SHIPPED_FILE = path.join(__dirname, '..', 'data', 'skills', 'keyword-forms.json');
const shipped = JSON.parse(fs.readFileSync(SHIPPED_FILE, 'utf8')).groups;
const shippedIndex = indexKeywordForms(shipped);

// The family ids the spec defines; the registry module is preferred when it is built.
const SPEC_FAMILY_IDS = [
  'devops-sre', 'software-engineering', 'data', 'qa-testing', 'product-management', 'design', 'it-support',
  'sales', 'marketing', 'finance-accounting', 'healthcare', 'human-resources', 'operations-project',
  'customer-success', 'education', 'legal', 'generic',
];
function knownFamilyIds() {
  for (const modulePath of ['../dist/services/jobFamilies/registry', '../dist/services/jobFamilies/index']) {
    try {
      const { JOB_FAMILIES } = require(modulePath);
      if (Array.isArray(JOB_FAMILIES) && JOB_FAMILIES.length > 0) return new Set(JOB_FAMILIES.map((family) => family.id));
    } catch {
      // not built yet: fall through to the spec's list
    }
  }
  return new Set(SPEC_FAMILY_IDS);
}

const sample = [
  { kind: 'acronym', forms: ['Infrastructure as Code', 'IaC'] },
  { kind: 'acronym', forms: ['Kubernetes', 'K8s', 'kube'] },
  { kind: 'acronym', forms: ['Amazon Web Services', 'AWS', 'AWS Cloud'] },
  { kind: 'acronym', forms: ['Amazon Elastic Kubernetes Service', 'EKS'] },
  { kind: 'acronym', forms: ['Financial Planning and Analysis', 'FP&A'], display: 'Financial Planning & Analysis (FP&A)' },
  { kind: 'alias', forms: ['PostgreSQL', 'Postgres', 'psql'] },
  { kind: 'alias', forms: ['CI/CD', 'CICD', 'Continuous Integration and Continuous Delivery'] },
  { kind: 'acronym', forms: ['Content Management System', 'CMS'], families: ['marketing'] },
];
const index = indexKeywordForms(sample);

test('normalizeKeyword trims, collapses whitespace and lower-cases', () => {
  assert.equal(normalizeKeyword('  Infrastructure   as\tCode '), 'infrastructure as code');
  assert.equal(normalizeKeyword('K8s'), 'k8s');
  assert.equal(normalizeKeyword(undefined), '');
});

test('keywordKey maps every form of a group to its primary form, case-insensitively', () => {
  assert.equal(keywordKey('IaC', index), 'infrastructure as code');
  assert.equal(keywordKey('iac', index), 'infrastructure as code');
  assert.equal(keywordKey('  infrastructure  as code ', index), 'infrastructure as code');
  assert.equal(keywordKey('kube', index), 'kubernetes');
  assert.equal(keywordKey('AWS Cloud', index), keywordKey('AWS', index));
  assert.equal(keywordKey('Terraform', index), 'terraform', 'an unknown term keys to its normalized self');
});

test('a rendered pair is recognised as its group; other parentheticals are left alone', () => {
  assert.equal(keywordKey('Infrastructure as Code (IaC)', index), keywordKey('IaC', index));
  assert.equal(keywordKey('IaC (Infrastructure as Code)', index), keywordKey('IaC', index));
  assert.notEqual(keywordKey('Python (Django)', index), keywordKey('Python', index));
  assert.equal(keywordKey('Python (Django)', index), 'python (django)');
  assert.equal(keywordKey('Kubernetes (EKS)', index), 'kubernetes (eks)', 'EKS is a different group, so nothing is stripped');
  assert.equal(keywordKey('Kubernetes (3 years)', index), 'kubernetes (3 years)');
});

test('sameKeyword compares by key', () => {
  assert.equal(sameKeyword('IaC', 'Infrastructure as Code', index), true);
  assert.equal(sameKeyword('K8s', 'kubernetes', index), true);
  assert.equal(sameKeyword('psql', 'PostgreSQL', index), true);
  assert.equal(sameKeyword('CICD', 'Continuous Integration and Continuous Delivery', index), true);
  assert.equal(sameKeyword('Kubernetes', 'EKS', index), false);
  assert.equal(sameKeyword('Terraform', 'terraform', index), true);
});

test('formsOf returns the group in file order, primary first, or [term] when unknown', () => {
  assert.deepEqual(formsOf('psql', index), ['PostgreSQL', 'Postgres', 'psql']);
  assert.deepEqual(formsOf('kube', index), ['Kubernetes', 'K8s', 'kube']);
  assert.deepEqual(formsOf('Infrastructure as Code (IaC)', index), ['Infrastructure as Code', 'IaC']);
  assert.deepEqual(formsOf('Terraform', index), ['Terraform']);
  assert.equal(formsOf('psql', index)[0], 'PostgreSQL', 'forms[0] is the canonical display spelling');
});

test('pairedForm renders acronym groups as Long (SHORT) and leaves aliases and unknowns unchanged', () => {
  assert.equal(pairedForm('IaC', index), 'Infrastructure as Code (IaC)');
  assert.equal(pairedForm('infrastructure as code', index), 'Infrastructure as Code (IaC)');
  assert.equal(pairedForm('AWS Cloud', index), 'Amazon Web Services (AWS)', 'forms[2..] only affect equality');
  assert.equal(pairedForm('Postgres', index), 'Postgres');
  assert.equal(pairedForm('CI/CD', index), 'CI/CD');
  assert.equal(pairedForm('Terraform', index), 'Terraform');
  assert.equal(pairedForm('', index), '');
});

test('pairedForm never double-wraps and never rewrites a foreign parenthetical', () => {
  assert.equal(pairedForm('Infrastructure as Code (IaC)', index), 'Infrastructure as Code (IaC)');
  assert.equal(pairedForm('IaC (Infrastructure as Code)', index), 'Infrastructure as Code (IaC)');
  assert.equal(pairedForm('Kubernetes (EKS)', index), 'Kubernetes (EKS)');
  assert.equal(pairedForm('Python (Django)', index), 'Python (Django)');
  const rendered = pairedForm('FP&A', index);
  assert.equal(rendered, 'Financial Planning & Analysis (FP&A)', 'display overrides the rendering');
  assert.equal(pairedForm(rendered, index), rendered, 'the display string resolves to its group');
  assert.equal(keywordKey(rendered, index), keywordKey('FP&A', index));
});

test('pairAcronyms maps pairedForm and drops later duplicates by key, keeping first position', () => {
  const paired = pairAcronyms(['Kubernetes', 'K8s', 'IaC', 'Postgres', 'postgresql', 'Terraform', '', 'kube', 'Infrastructure as Code (IaC)'], index);
  assert.deepEqual(paired, ['Kubernetes (K8s)', 'Infrastructure as Code (IaC)', 'Postgres', 'Terraform']);
});

test('relevantGroups returns the groups the terms belong to, once each, in index order', () => {
  const groups = relevantGroups(['psql', 'Terraform', 'K8s', 'Infrastructure as Code (IaC)', 'kube'], index);
  assert.deepEqual(groups.map((group) => group.forms[0]), ['Infrastructure as Code', 'Kubernetes', 'PostgreSQL']);
  assert.deepEqual(groups[2], { kind: 'alias', forms: ['PostgreSQL', 'Postgres', 'psql'] });
  assert.deepEqual(relevantGroups(['Terraform'], index), []);
});

test('groupsFromPairs sanitizes model output', () => {
  assert.deepEqual(groupsFromPairs([{ long: ' Infrastructure   as Code ', short: '(IaC)' }]), [
    { kind: 'acronym', forms: ['Infrastructure as Code', 'IaC'] },
  ]);
  assert.deepEqual(groupsFromPairs([{ long: 'Infrastructure as Code (IaC)', short: 'IaC' }]), [
    { kind: 'acronym', forms: ['Infrastructure as Code', 'IaC'] },
  ], 'a long that already carries the pair loses that tail');
  assert.deepEqual(groupsFromPairs([
    { long: '', short: 'IaC' },
    { long: 'Kubernetes', short: '' },
    { long: 'K8s', short: 'k8s' },
    { long: 'K8s', short: 'Kubernetes' },
    { long: 'Site Reliability Engineering', short: 'SRE' },
    { long: 'Something Reliability Else', short: 'sre' },
    null,
    'Kubernetes',
    { long: 42, short: 'X' },
  ]), [{ kind: 'acronym', forms: ['Site Reliability Engineering', 'SRE'] }]);
  assert.deepEqual(groupsFromPairs(undefined), []);
  assert.deepEqual(groupsFromPairs(null), []);
  assert.deepEqual(groupsFromPairs('nope'), []);
});

test('merging posting pairs after the registry: the later group wins a contested form', () => {
  const registry = [{ kind: 'acronym', forms: ['Site Reliability Engineer', 'SRE'] }, { kind: 'acronym', forms: ['Kubernetes', 'K8s'] }];
  const merged = indexKeywordForms([...registry, ...groupsFromPairs([{ long: 'Site Reliability Engineering', short: 'SRE' }])]);
  assert.equal(pairedForm('SRE', merged), 'Site Reliability Engineering (SRE)', "the posting's wording is rendered");
  assert.equal(sameKeyword('SRE', 'Site Reliability Engineering', merged), true);
  assert.deepEqual(formsOf('Site Reliability Engineer', merged), ['Site Reliability Engineer', 'SRE'], 'the registry keeps the forms nobody contested');
  assert.equal(merged.groups.length, 3);

  const shadowed = indexKeywordForms([...registry, ...groupsFromPairs([{ long: 'Kubernetes', short: 'K8s' }])]);
  assert.equal(shadowed.groups.length, 2, 'a group whose every form was claimed later is dropped');

  const odd = indexKeywordForms([...registry, ...groupsFromPairs([{ long: 'Kubernetes', short: 'EKS' }])]);
  assert.equal(pairedForm('Kubernetes', odd), 'Kubernetes (EKS)');
  assert.deepEqual(formsOf('K8s', odd), ['Kubernetes', 'K8s'], 'uncontested forms stay with the registry');
});

test('indexKeywordForms never throws and skips malformed groups', () => {
  const garbage = indexKeywordForms([
    null,
    42,
    'IaC',
    { kind: 'other', forms: ['A', 'B'] },
    { kind: 'alias', forms: 'nope' },
    { kind: 'acronym', forms: ['Only One'] },
    { kind: 'alias', forms: [' a ', 'A', ''] },
    { kind: 'alias', forms: ['Good', 'Fine'], families: 'x' },
  ]);
  assert.deepEqual(garbage.groups, [{ kind: 'alias', forms: ['Good', 'Fine'] }]);
  assert.deepEqual(indexKeywordForms(undefined).groups, []);
  assert.equal(keywordKey('IaC', indexKeywordForms([])), 'iac');
});

test('sanitizeKeywordFormGroup cleans forms, display and families', () => {
  assert.deepEqual(
    sanitizeKeywordFormGroup({ kind: 'acronym', forms: [' Long  Form ', 'LF', 'lf', 7], display: ' Long Form (LF) ', families: [' data ', '', 'data'], note: 'x' }),
    { kind: 'acronym', forms: ['Long Form', 'LF'], display: 'Long Form (LF)', families: ['data'] }
  );
  assert.deepEqual(sanitizeKeywordFormGroup({ kind: 'alias', forms: ['A', 'B'], families: [] }), { kind: 'alias', forms: ['A', 'B'] });
  assert.equal(sanitizeKeywordFormGroup({ kind: 'alias', forms: ['A'] }), undefined);
});

test('groupsForFamily keeps unscoped groups everywhere and scoped ones only for their family', () => {
  const marketing = indexKeywordForms(groupsForFamily(sample, 'marketing'));
  const healthcare = indexKeywordForms(groupsForFamily(sample, 'healthcare'));
  assert.equal(pairedForm('CMS', marketing), 'Content Management System (CMS)');
  assert.equal(pairedForm('CMS', healthcare), 'CMS');
  assert.equal(pairedForm('IaC', healthcare), 'Infrastructure as Code (IaC)');
  assert.equal(groupsForFamily(sample, 'healthcare').length, sample.length - 1);
});

test('shipped file: every group is clean, unique inside itself, and acronym groups pair two forms', () => {
  assert.ok(shipped.length >= 100, `ships ${shipped.length} groups`);
  for (const group of shipped) {
    assert.deepEqual(sanitizeKeywordFormGroup(group), group, `group ${group.forms[0]} is stored clean`);
    assert.ok(group.forms.every((form) => form.length > 0));
    assert.equal(new Set(group.forms.map(normalizeKeyword)).size, group.forms.length, `duplicate form inside ${group.forms[0]}`);
    if (group.kind === 'acronym') assert.ok(group.forms.length >= 2, `${group.forms[0]} has no acronym`);
  }
});

test('shipped file: no form belongs to two groups unless both are scoped to families that never overlap', () => {
  const owners = new Map();
  for (const group of shipped) {
    const keys = group.forms.map(normalizeKeyword);
    if (group.display) keys.push(normalizeKeyword(group.display));
    for (const key of keys) {
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(group);
    }
  }
  for (const [form, groups] of owners) {
    if (groups.length === 1) continue;
    const scoped = groups.every((group) => Array.isArray(group.families) && group.families.length > 0);
    const disjoint = groups.every((a, i) => groups.every((b, j) => i === j || !a.families.some((id) => b.families.includes(id))));
    assert.ok(scoped && disjoint, `"${form}" is claimed by ${groups.map((group) => group.forms[0]).join(' and ')}`);
  }
  for (const id of knownFamilyIds()) {
    const perFamily = groupsForFamily(shipped, id);
    assert.equal(indexKeywordForms(perFamily).groups.length, perFamily.length, `family ${id} has a collision`);
  }
});

test('shipped file: every families id names a known job family', () => {
  const known = knownFamilyIds();
  for (const group of shipped) {
    for (const id of group.families ?? []) assert.ok(known.has(id), `${group.forms[0]} names unknown family ${id}`);
  }
  assert.ok(shipped.some((group) => group.families), 'ambiguous acronyms ship scoped');
});

test("shipped file: the spec's acronyms are present once, and forms nobody writes long are not paired", () => {
  const wanted = [
    'IaC', 'SRE', 'K8s', 'AWS', 'GCP', 'SLO', 'SLA', 'SLI', 'MTTR', 'RBAC', 'IAM', 'VPC', 'EKS', 'ECS',
    'ML', 'AI', 'NLP', 'LLM', 'ETL', 'BI', 'KPI', 'CRM', 'ERP',
    'RN', 'LPN', 'CNA', 'BLS', 'ACLS', 'PALS', 'EHR', 'EMR', 'HIPAA', 'ICU', 'ER',
    'CPA', 'GAAP', 'IFRS', 'SOX', 'FP&A', 'AP', 'AR', 'GL', 'CFA', 'CMA',
    'PMP', 'CSM', 'PMO', 'SDLC', 'OKR', 'RFP', 'SOP', 'Six Sigma',
    'SEO', 'SEM', 'PPC', 'CMS', 'CTR', 'ROI', 'HRIS', 'ATS', 'PEO', 'FMLA', 'EEO', 'NDA', 'IP', 'GDPR', 'CCPA',
  ];
  for (const term of wanted) {
    assert.equal(relevantGroups([term], shippedIndex).length, 1, `${term} is missing`);
  }
  for (const term of ['KPI', 'CRM', 'SLA', 'IAM', 'CI/CD']) {
    assert.equal(shipped.filter((group) => group.forms.map(normalizeKeyword).includes(normalizeKeyword(term))).length, 1, `${term} ships once`);
  }
  for (const term of ['API', 'HTML', 'CSS', 'SQL', 'GitHub Actions', 'GitLab CI']) {
    assert.equal(pairedForm(term, shippedIndex), term);
    assert.equal(keywordKey(term, shippedIndex), normalizeKeyword(term), `${term} is not aliased to anything`);
  }
});

test('shipped file: CI/CD is an alias group that never renders a pair', () => {
  const group = relevantGroups(['CI/CD'], shippedIndex)[0];
  assert.equal(group.kind, 'alias');
  assert.equal(pairedForm('CI/CD', shippedIndex), 'CI/CD');
  assert.equal(sameKeyword('CICD', 'Continuous Integration and Continuous Delivery', shippedIndex), true);
  assert.equal(sameKeyword('CI/CD', 'Continuous Integration/Continuous Delivery', shippedIndex), true);
});

test('shipped file: ported spelling aliases resolve to their canonical display spelling', () => {
  assert.equal(formsOf('reactjs', shippedIndex)[0], 'React');
  assert.equal(formsOf('psql', shippedIndex)[0], 'PostgreSQL');
  assert.equal(formsOf('dotnet', shippedIndex)[0], '.NET');
  assert.equal(formsOf('nodejs', shippedIndex)[0], 'Node.js');
  assert.equal(formsOf('golang', shippedIndex)[0], 'Go');
  assert.equal(formsOf('kube', shippedIndex)[0], 'Kubernetes');
  assert.equal(formsOf('google cloud', shippedIndex)[0], 'Google Cloud Platform');
  assert.equal(formsOf('rest api', shippedIndex)[0], 'RESTful API');
  assert.equal(pairedForm('AWS Cloud', shippedIndex), 'Amazon Web Services (AWS)');
  assert.equal(pairedForm('Infrastructure as Code (IaC)', shippedIndex), 'Infrastructure as Code (IaC)');
  assert.equal(pairedForm('Kubernetes (EKS)', shippedIndex), 'Kubernetes (EKS)');
  assert.notEqual(keywordKey('Python (Django)', shippedIndex), keywordKey('Python', shippedIndex));
  assert.equal(keywordKey('Infrastructure as Code (IaC)', shippedIndex), keywordKey('IaC', shippedIndex));
});

test('shipped file: an ambiguous acronym renders only inside its family', () => {
  const nurse = indexKeywordForms(groupsForFamily(shipped, 'healthcare'));
  const marketer = indexKeywordForms(groupsForFamily(shipped, 'marketing'));
  const accountant = indexKeywordForms(groupsForFamily(shipped, 'finance-accounting'));
  assert.equal(pairedForm('CMS', nurse), 'CMS');
  assert.equal(pairedForm('CMS', marketer), 'Content Management System (CMS)');
  assert.equal(pairedForm('CMA', nurse), 'Certified Medical Assistant (CMA)');
  assert.equal(pairedForm('CMA', accountant), 'Certified Management Accountant (CMA)');
  assert.equal(pairedForm('AR', marketer), 'AR');
  assert.equal(pairedForm('AR', accountant), 'Accounts Receivable (AR)');
  assert.equal(pairedForm('IaC', nurse), 'Infrastructure as Code (IaC)', 'unscoped groups apply everywhere');
});

function writeDataFile(dataDir, content) {
  const skillsDir = path.join(dataDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const file = path.join(skillsDir, 'keyword-forms.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

test('database: an empty data dir yields the built-in groups and never creates the file', () => {
  const dataDir = makeTempDataDir('keyword-forms-empty');
  process.env.TAILOR_DATA_DIR = dataDir;
  const db = loadFresh('../dist/database/keywordFormsDatabase');

  const groups = db.readKeywordForms();
  assert.deepEqual(groups, mergeKeywordFormGroups(shipped));
  assert.ok(groups.length >= 100);
  assert.equal(fs.existsSync(path.join(dataDir, 'skills', 'keyword-forms.json')), false);

  const paths = db.getKeywordFormsPaths();
  assert.equal(path.normalize(paths.dataFile), path.normalize(path.join(dataDir, 'skills', 'keyword-forms.json')));
  assert.equal(path.normalize(paths.builtIn), path.normalize(SHIPPED_FILE));
  assert.equal(db.readKeywordForms(), groups, 'cached until refreshed');
});

test('database: a data-dir file extends the built-in registry instead of replacing it', () => {
  const dataDir = makeTempDataDir('keyword-forms-overlay');
  process.env.TAILOR_DATA_DIR = dataDir;
  writeDataFile(dataDir, { groups: [{ kind: 'acronym', forms: ['Zork Query Language', 'ZQL'] }] });
  const db = loadFresh('../dist/database/keywordFormsDatabase');

  const groups = db.readKeywordForms();
  assert.equal(groups.length, mergeKeywordFormGroups(shipped).length + 1);
  const idx = indexKeywordForms(groups);
  assert.equal(pairedForm('ZQL', idx), 'Zork Query Language (ZQL)');
  assert.equal(pairedForm('IaC', idx), 'Infrastructure as Code (IaC)', 'built-in groups are still there');
});

test('database: a data-dir group that redefines a built-in one wins its forms', () => {
  const dataDir = makeTempDataDir('keyword-forms-override');
  process.env.TAILOR_DATA_DIR = dataDir;
  writeDataFile(dataDir, { groups: [{ kind: 'acronym', forms: ['Kubernetes', 'K8s', 'kube', 'k8'] }] });
  const db = loadFresh('../dist/database/keywordFormsDatabase');

  const groups = db.readKeywordForms();
  assert.equal(groups.length, mergeKeywordFormGroups(shipped).length, 'the shadowed built-in group is dropped, not doubled');
  const idx = indexKeywordForms(groups);
  assert.deepEqual(formsOf('k8', idx), ['Kubernetes', 'K8s', 'kube', 'k8']);
  assert.deepEqual(formsOf('K8s', idx), ['Kubernetes', 'K8s', 'kube', 'k8']);
});

test('database: malformed entries in the data-dir file are skipped, the rest is kept', () => {
  const dataDir = makeTempDataDir('keyword-forms-malformed');
  process.env.TAILOR_DATA_DIR = dataDir;
  writeDataFile(dataDir, {
    groups: [
      null,
      { kind: 'nope', forms: ['A', 'B'] },
      { kind: 'alias', forms: 'x' },
      { kind: 'acronym', forms: ['Lonely'] },
      { kind: 'alias', forms: [' Zork  Query ', 'ZQ', 'zq'] },
    ],
  });
  const db = loadFresh('../dist/database/keywordFormsDatabase');

  const groups = db.readKeywordForms();
  assert.equal(groups.length, mergeKeywordFormGroups(shipped).length + 1);
  assert.deepEqual(groups[groups.length - 1], { kind: 'alias', forms: ['Zork Query', 'ZQ'] });
});

test('database: a corrupt or shapeless data-dir file falls back to the built-in groups', () => {
  for (const content of ['{not json', '[]', '{"groups":"nope"}', '{"other":[]}']) {
    const dataDir = makeTempDataDir('keyword-forms-corrupt');
    process.env.TAILOR_DATA_DIR = dataDir;
    writeDataFile(dataDir, content);
    const db = loadFresh('../dist/database/keywordFormsDatabase');
    assert.deepEqual(db.readKeywordForms(), mergeKeywordFormGroups(shipped), `content ${content}`);
  }
});

test('database: refreshKeywordForms re-reads the files', () => {
  const dataDir = makeTempDataDir('keyword-forms-refresh');
  process.env.TAILOR_DATA_DIR = dataDir;
  const db = loadFresh('../dist/database/keywordFormsDatabase');
  const before = db.readKeywordForms().length;

  writeDataFile(dataDir, { groups: [{ kind: 'alias', forms: ['Zork', 'Zorkish'] }] });
  assert.equal(db.readKeywordForms().length, before, 'stale until refreshed');
  assert.equal(db.refreshKeywordForms().length, before + 1);
  assert.equal(db.readKeywordForms().length, before + 1);
});

test('database: without TAILOR_DATA_DIR the built-in file is read once, not overlaid on itself', () => {
  const saved = process.env.TAILOR_DATA_DIR;
  delete process.env.TAILOR_DATA_DIR;
  try {
    const db = loadFresh('../dist/database/keywordFormsDatabase');
    const paths = db.getKeywordFormsPaths();
    assert.equal(path.normalize(paths.dataFile), path.normalize(paths.builtIn));
    assert.equal(db.readKeywordForms().length, mergeKeywordFormGroups(shipped).length);
  } finally {
    if (saved !== undefined) process.env.TAILOR_DATA_DIR = saved;
  }
});
