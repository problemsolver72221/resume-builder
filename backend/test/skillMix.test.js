const assert = require('node:assert/strict');
const test = require('node:test');

const {
  capHardSkillGroups,
  mixSkillSections,
  HARD_SKILL_KEYWORD_CAP,
  HARD_SKILL_TARGET,
  SOFT_SKILL_MIN,
  SOFT_SKILL_MAX,
} = require('../dist/services/utils/skillMix');
const { hashSeed } = require('../dist/utils/seededRandom');

// A posting with 60 keywords, most important first; the first ten are must-haves.
const job = Array.from({ length: 60 }, (_, index) => `Job${index + 1}`);
const mustHave = job.slice(0, 10);
// A candidate who evidences three of the posting's keywords and has fifteen skills of their own.
const own = ['Job3', 'Job7', 'Job11', ...Array.from({ length: 15 }, (_, index) => `Own${index + 1}`)];
const jobSoft = [
  'Communication', 'Ownership', 'Collaboration', 'Mentorship', 'Autonomy', 'Reliability', 'Problem-solving',
  'Transparency', 'Leadership', 'Curiosity', 'Empathy', 'Adaptability', 'Accountability', 'Initiative', 'Attention to detail',
];
const ownSoft = ['Ownership', 'Curiosity', 'Patience'];
const build = (seed, overrides = {}) =>
  mixSkillSections({
    jobHardSkills: job,
    mustHaveHardSkills: mustHave,
    profileHardSkills: own,
    jobSoftSkills: jobSoft,
    profileSoftSkills: ownSoft,
    seed,
    ...overrides,
  });

test('the analysis keeps 60 keywords and a resume shows 45 hard skills', () => {
  assert.equal(HARD_SKILL_KEYWORD_CAP, 60);
  assert.equal(HARD_SKILL_TARGET, 45);
});

test('a seed always yields the same section, filled to the target', () => {
  assert.deepEqual(build(7), build(7));
  assert.equal(build(7).hardSkills.length, HARD_SKILL_TARGET);
});

test("own-and-posted skills lead, then must-haves, then all of the candidate's own, then the posting by priority", () => {
  const { hardSkills } = build(7);
  assert.deepEqual(new Set(hardSkills.slice(0, 3)), new Set(['Job3', 'Job7', 'Job11']));
  assert.deepEqual(
    new Set(hardSkills.slice(3, 11)),
    new Set(['Job1', 'Job2', 'Job4', 'Job5', 'Job6', 'Job8', 'Job9', 'Job10']),
    'the remaining must-haves come next'
  );
  assert.deepEqual(new Set(hardSkills.slice(11, 26)), new Set(own.slice(3)), "every one of the candidate's own skills is kept");
  // 19 open slots: the next 10 most important keywords outright, then 9 drawn from the rest.
  assert.deepEqual(hardSkills.slice(26, 36), job.slice(11, 21), 'half of the open slots go to the next most important keywords');
  const rest = new Set(job.slice(21));
  assert.ok(hardSkills.slice(36).every((skill) => rest.has(skill)), 'the other half is drawn from what is left');
  assert.equal(new Set(hardSkills.map((skill) => skill.toLowerCase())).size, hardSkills.length, 'no duplicates');
});

test("the random half of the draw favours the posting's higher-priority keywords", () => {
  const seeds = 200;
  const picks = new Map();
  for (let seed = 1; seed <= seeds; seed += 1) {
    for (const skill of build(seed).hardSkills.slice(36)) picks.set(skill, (picks.get(skill) ?? 0) + 1);
  }
  const rate = (skill) => (picks.get(skill) ?? 0) / seeds;
  assert.ok(rate('Job22') > 0.25, `top of the draw pool taken in ${Math.round(rate('Job22') * 100)}% of runs`);
  assert.ok(rate('Job60') < 0.1, `bottom of the draw pool taken in ${Math.round(rate('Job60') * 100)}% of runs`);
  assert.ok(rate('Job22') > rate('Job41') && rate('Job41') > rate('Job60'), 'more likely the more important');
  assert.ok(picks.size >= 25, `the draw varies: ${picks.size} distinct keywords taken across ${seeds} candidates`);
});

test('nine candidates applying for one posting get nine different lists', () => {
  const lists = Array.from({ length: 9 }, (_, index) => build(hashSeed(`candidate-${index}|posting`)).hardSkills);
  for (let a = 0; a < lists.length; a += 1) {
    for (let b = a + 1; b < lists.length; b += 1) {
      assert.notDeepEqual(lists[a], lists[b]);
      const shared = lists[a].filter((skill) => lists[b].includes(skill)).length;
      assert.ok(shared < HARD_SKILL_TARGET, 'lists differ in content, not just order');
    }
  }
});

test('case-insensitive duplicates across inputs collapse to one entry', () => {
  const { hardSkills } = build(1, { jobHardSkills: ['Node.js', 'React'], profileHardSkills: ['node.js', 'Vue'] });
  assert.deepEqual(hardSkills.map((skill) => skill.toLowerCase()).sort(), ['node.js', 'react', 'vue']);
});

test('short pools give a short list, never padding', () => {
  const { hardSkills } = build(3, { jobHardSkills: job.slice(0, 5), profileHardSkills: ['Own1', 'Own2'] });
  assert.equal(hardSkills.length, 7);
});

test("soft skills: 12-15 per candidate, evidenced ones first, then the candidate's own", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { softSkills } = build(seed);
    assert.ok(softSkills.length >= SOFT_SKILL_MIN && softSkills.length <= SOFT_SKILL_MAX, `got ${softSkills.length}`);
    assert.deepEqual(new Set(softSkills.slice(0, 2)), new Set(['Ownership', 'Curiosity']));
    assert.equal(softSkills[2], 'Patience', "the candidate's own soft skill is kept ahead of the posting's");
  }
});

test('capHardSkillGroups spends the budget required-first and counts a repeated skill once', () => {
  const group = (prefix) => Array.from({ length: 20 }, (_, index) => `${prefix}${index + 1}`);
  const capped = capHardSkillGroups({
    required: group('Req'),
    technologies: ['Req1', ...group('Tech')],
    tools: group('Tool'),
    preferred: group('Pref'),
  });
  const total = capped.required.length + capped.technologies.length + capped.tools.length + capped.preferred.length;
  assert.equal(total, 60);
  assert.equal(capped.required.length, 20, 'required skills are never cut first');
  assert.equal(capped.technologies.includes('Req1'), false, 'a skill in two groups counts once');
  assert.equal(capped.technologies.length, 20);
  assert.equal(capped.tools.length, 20);
  assert.deepEqual(capped.preferred, []);
});

// Keyed path: keywordKey from the keyword-forms registry makes "IaC" and "Infrastructure as Code" one skill.
const { indexKeywordForms, keywordKey } = require('../dist/services/utils/keywordForms');
const formsIndex = indexKeywordForms([
  { kind: 'acronym', forms: ['Infrastructure as Code', 'IaC'] },
  { kind: 'acronym', forms: ['Kubernetes', 'K8s'] },
  { kind: 'alias', forms: ['Problem-Solving', 'Problem Solving'] },
]);
const byForms = (skill) => keywordKey(skill, formsIndex);

test('with no key the mix behaves exactly like plain case-folding', () => {
  assert.deepEqual(build(7), build(7, { key: (skill) => skill.trim().toLowerCase() }));
});

test('a key makes the acronym in the profile and the long form in the posting one evidenced skill', () => {
  const { hardSkills } = build(5, {
    jobHardSkills: ['Infrastructure as Code', 'Terraform', 'K8s'],
    mustHaveHardSkills: ['Infrastructure as Code'],
    profileHardSkills: ['IaC', 'Kubernetes', 'Ansible'],
    key: byForms,
  });
  assert.deepEqual(new Set(hardSkills.slice(0, 2)), new Set(['Infrastructure as Code', 'K8s']), "evidenced skills lead, in the posting's spelling");
  assert.deepEqual([...hardSkills].sort(), ['Ansible', 'Infrastructure as Code', 'K8s', 'Terraform']);
  assert.equal(new Set(hardSkills.map(byForms)).size, hardSkills.length, 'no spelling is listed twice');
});

test('a must-have written as the acronym still matches the posting keyword written long', () => {
  const { hardSkills } = build(2, {
    jobHardSkills: ['Terraform', 'Infrastructure as Code', 'Ansible'],
    mustHaveHardSkills: ['IaC'],
    profileHardSkills: [],
    key: byForms,
  });
  assert.equal(hardSkills[0], 'Infrastructure as Code');
});

test('soft skills collapse spelling variants under the key too', () => {
  const { softSkills } = build(4, { jobSoftSkills: ['Problem-Solving', 'Empathy'], profileSoftSkills: ['Problem Solving'], key: byForms });
  assert.deepEqual(softSkills, ['Problem-Solving', 'Empathy']);
});

test('capHardSkillGroups accepts a key so one keyword in two spellings spends one slot', () => {
  const groups = { required: ['IaC'], technologies: ['Infrastructure as Code', 'K8s'], tools: ['Kubernetes'], preferred: [] };
  assert.deepEqual(capHardSkillGroups(groups), { required: ['IaC'], technologies: ['Infrastructure as Code', 'K8s'], tools: ['Kubernetes'], preferred: [] });
  assert.deepEqual(capHardSkillGroups(groups, 60, byForms), { required: ['IaC'], technologies: ['K8s'], tools: [], preferred: [] });
});

test('hashSeed is stable and separates candidates and postings', () => {
  assert.equal(hashSeed('a|b'), hashSeed('a|b'));
  assert.notEqual(hashSeed('a|b'), hashSeed('a|c'));
  assert.notEqual(hashSeed('a|b'), hashSeed('b|b'));
});
