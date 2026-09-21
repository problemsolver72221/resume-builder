const assert = require('node:assert/strict');
const test = require('node:test');

const { mergeRoleIdentities } = require('../dist/services/utils/experienceMerge');

const profile = {
  experience: [
    { title: 'Staff Engineer', company: 'Northwind Health', startDate: '2021-03', endDate: 'Present', location: 'Austin, TX' },
    { title: 'Senior Engineer', company: 'Contoso Labs', startDate: '2018-01', endDate: '2021-02', location: 'Denver, CO' },
    { title: 'Engineer', company: 'Fabrikam', startDate: '2015-06', endDate: '2017-12', location: 'Remote' },
  ],
};

const identity = (entry) => [entry.title, entry.company, entry.startDate, entry.endDate, entry.location];

test('role identity comes from the profile, never from the reply', () => {
  // The model answers in the new shape and also tries to restate facts; the facts lose.
  const merged = mergeRoleIdentities(
    [
      { index: 0, description: 'led platform work', achievements: ['a'], company: 'Northwynd Health Inc', startDate: '2020-01' },
      { index: 1, description: 'built services', achievements: ['b'], title: 'Principal Engineer' },
    ],
    profile
  );

  assert.deepEqual(identity(merged[0]), ['Staff Engineer', 'Northwind Health', '2021-03', 'Present', 'Austin, TX']);
  assert.deepEqual(identity(merged[1]), ['Senior Engineer', 'Contoso Labs', '2018-01', '2021-02', 'Denver, CO']);
  // The prose the model actually wrote is kept untouched.
  assert.equal(merged[0].description, 'led platform work');
  assert.deepEqual(merged[1].achievements, ['b']);
});

test('roles come back in profile order however the model ordered them', () => {
  const merged = mergeRoleIdentities(
    [
      { index: 2, description: 'earliest' },
      { index: 0, description: 'latest' },
      { index: 1, description: 'middle' },
    ],
    profile
  );

  assert.deepEqual(merged.map((e) => e.company), ['Northwind Health', 'Contoso Labs', 'Fabrikam']);
  assert.deepEqual(merged.map((e) => e.description), ['latest', 'middle', 'earliest']);
});

test('a reply in the older shape still resolves, by company then by position', () => {
  const byCompany = mergeRoleIdentities(
    [{ company: 'fabrikam', description: 'x' }, { company: 'Contoso Labs', description: 'y' }],
    profile
  );
  assert.deepEqual(byCompany.map((e) => e.company), ['Contoso Labs', 'Fabrikam']);
  assert.deepEqual(byCompany.map((e) => e.description), ['y', 'x']);

  const byPosition = mergeRoleIdentities([{ description: 'first' }, { description: 'second' }], profile);
  assert.deepEqual(byPosition.map((e) => e.company), ['Northwind Health', 'Contoso Labs']);
});

test('a repeated or out-of-range index cannot claim a role twice', () => {
  const repeated = mergeRoleIdentities(
    [{ index: 0, description: 'first' }, { index: 0, description: 'second' }],
    profile
  );
  // The second entry falls through to an unclaimed role rather than overwriting the first.
  assert.deepEqual(repeated.map((e) => e.company), ['Northwind Health', 'Contoso Labs']);
  assert.equal(new Set(repeated.map((e) => e.company)).size, 2);

  const outOfRange = mergeRoleIdentities([{ index: 99, description: 'x' }], profile);
  assert.equal(outOfRange[0].company, 'Northwind Health', 'falls back to position 0');

  const notAnInteger = mergeRoleIdentities([{ index: 1.5, description: 'x' }], profile);
  assert.equal(notAnInteger[0].company, 'Northwind Health');
});

test('roles the model dropped stay dropped', () => {
  const merged = mergeRoleIdentities([{ index: 0, description: 'only the recent one' }], profile);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].company, 'Northwind Health');
});

test('more entries than the profile has roles: the surplus keeps its own fields, last', () => {
  const merged = mergeRoleIdentities(
    [
      { index: 0, description: 'real' },
      { index: 1, description: 'real too' },
      { index: 2, description: 'real three' },
      { company: 'Invented Corp', title: 'Ghost', description: 'hallucinated' },
    ],
    profile
  );

  assert.equal(merged.length, 4);
  assert.deepEqual(merged.slice(0, 3).map((e) => e.company), ['Northwind Health', 'Contoso Labs', 'Fabrikam']);
  // Nothing in the profile matches it, so it is passed through rather than silently retitled.
  assert.equal(merged[3].company, 'Invented Corp');
});

test('without a profile the reply is left as it is, with identity fields filled in', () => {
  const merged = mergeRoleIdentities([{ company: 'Solo Ltd', description: 'x' }], undefined);
  assert.deepEqual(identity(merged[0]), ['', 'Solo Ltd', '', '', '']);

  const empty = mergeRoleIdentities([{ description: 'x' }], { experience: [] });
  assert.deepEqual(identity(empty[0]), ['', '', '', '', '']);
});

test('an empty reply merges to nothing', () => {
  assert.deepEqual(mergeRoleIdentities([], profile), []);
});
