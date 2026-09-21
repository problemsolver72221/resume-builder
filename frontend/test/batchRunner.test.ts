/**
 * The batch loop: the behaviour a long run depends on and nothing previously checked.
 *
 * Every case here is something that costs real money or real hours when it breaks — paying
 * twice for a job already analysed, regenerating files already on disk, losing the work a
 * stopped run did, or writing a batch into two date folders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runBatch } from '../src/features/builder/model/batchRunner';
import { summarizeBatchRun } from '../src/lib/batchState';
import {
  fakePort,
  failure,
  makeAnalysis,
  makeJob,
  makeProfiles,
  makeRun,
  recordingHooks,
} from './helpers';

const options = (profiles: ReturnType<typeof makeProfiles>, overrides = {}) => ({
  profiles,
  generationOptions: { format: 'both' as const, includeCoverLetterDocx: true, includeCoverLetter: true },
  roleFromInput: true,
  // The real schedule waits 30 s before the second pass; these tests exercise the retry
  // logic, not the clock.
  passDelayMs: () => 0,
  ...overrides,
});

test('a clean run generates every build and reports itself complete', async () => {
  const profiles = makeProfiles(3);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort();

  const result = await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(result.outcome.generated, 3);
  assert.equal(result.outcome.failed, 0);
  assert.equal(result.completed, true);
  assert.equal(result.errorMessage, undefined);
  assert.equal(port.calls.generate.length, 3);
  assert.ok(run.builds.every((b) => b.status === 'generated'));
});

test('one job is analysed once however many profiles build against it', async () => {
  const profiles = makeProfiles(4);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort();

  await runBatch(run, port, recordingHooks(), options(profiles));

  // The analysis is the per-posting cost; paying it per profile is the expensive mistake.
  assert.equal(port.calls.analyze.length, 1);
});

test('a resumed run reuses the analysis it already paid for', async () => {
  const profiles = makeProfiles(2);
  const job = makeJob();
  const run = makeRun({ jobs: [job], profiles, analyses: { '1': makeAnalysis('Stored') } });
  const port = fakePort();

  await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(port.calls.analyze.length, 0);
  assert.equal(port.calls.generate[0].jobAnalysis?.jobMeta.title, 'Stored');
});

test('a job too short to analyse is recorded as null and never retried', async () => {
  const profiles = makeProfiles(1);
  const run = makeRun({ jobs: [makeJob({ jobDescription: 'too short' })], profiles });
  const port = fakePort();

  await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(port.calls.analyze.length, 0);
  assert.equal(run.analyses['1'], null);
  assert.equal(port.calls.generate[0].jobAnalysis, undefined);
});

test('the first build pins the date folder for every later build in the run', async () => {
  const profiles = makeProfiles(3);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort({
    generate: {
      // Only the first build reports a date; a run that crossed midnight must not split.
      'Acme:p1': [{ outputDate: '2026-04-10' }],
      'Acme:p2': [{ outputDate: '2026-04-11' }],
      'Acme:p3': [{ outputDate: '2026-04-11' }],
    },
  });

  await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(run.outputDate, '2026-04-10');
  assert.equal(port.calls.generate[1].outputDate, '2026-04-10');
  assert.equal(port.calls.generate[2].outputDate, '2026-04-10');
});

test('skipExisting settles a build from disk without analysing or generating', async () => {
  const profiles = makeProfiles(2);
  const run = makeRun({ jobs: [makeJob()], profiles, skipExisting: true });
  const port = fakePort({ existing: { 'Acme:p1': [true], 'Acme:p2': [false] } });

  const result = await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(result.outcome.skipped, 1);
  assert.equal(result.outcome.generated, 1);
  assert.equal(port.calls.generate.length, 1);
  // The skipped build cost no analysis of its own; the other one paid for it.
  assert.equal(port.calls.analyze.length, 1);
  assert.equal(run.builds.find((b) => b.profileId === 'p1')?.status, 'skipped');
});

test('a build that fails permanently is not retried and needs a person', async () => {
  const profiles = makeProfiles(2);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort({
    generate: { 'Acme:p1': [failure('Insufficient credits', false)] },
  });

  const result = await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(result.outcome.failed, 1);
  assert.equal(result.outcome.failures[0].retryable, false);
  assert.equal(result.completed, false);
  assert.match(result.errorMessage ?? '', /a retry cannot fix/);
  // One attempt only: a permanent failure must not burn the retry budget.
  assert.equal(run.builds.find((b) => b.profileId === 'p1')?.attempts, 1);
});

test('a retryable failure is retried and can succeed on a later pass', async () => {
  const profiles = makeProfiles(1);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort({
    generate: { 'Acme:p1': [failure('Overloaded', true), { outputDate: '2026-04-10' }] },
  });

  const result = await runBatch(run, port, recordingHooks(), options(profiles));

  assert.equal(result.outcome.generated, 1);
  assert.equal(result.completed, true);
  assert.equal(run.builds[0].attempts, 2);
});

test('retryable failures are parked once they run out of attempts', async () => {
  const profiles = makeProfiles(1);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort({ generate: { 'Acme:p1': [failure('Overloaded', true)] } });

  const result = await runBatch(run, port, recordingHooks(), options(profiles, { maxAttempts: 2 }));

  assert.equal(result.outcome.failed, 1);
  assert.equal(result.completed, false);
  assert.equal(run.builds[0].attempts, 2);
  assert.match(result.errorMessage ?? '', /still failed after 2 attempts each and were parked/);
});

test('a failed analysis is not re-run for the job\'s other profiles in the same pass', async () => {
  const profiles = makeProfiles(3);
  const job = makeJob();
  const run = makeRun({ jobs: [job], profiles });
  const port = fakePort({
    analyze: { [job.jobDescription]: [failure('Overloaded', true)] },
  });

  await runBatch(run, port, recordingHooks(), options(profiles, { maxAttempts: 1 }));

  // Three builds share one posting; the pass must pay for the failure once, not three times.
  assert.equal(port.calls.analyze.length, 1);
});

test('stopping leaves every unfinished build resumable', async () => {
  const profiles = makeProfiles(4);
  const run = makeRun({ jobs: [makeJob()], profiles });
  let done = 0;
  const hooks = recordingHooks(() => done >= 2);
  const port = fakePort();
  const countingPort = {
    ...port,
    generate: async (input: Parameters<typeof port.generate>[0]) => {
      done += 1;
      return port.generate(input);
    },
  };

  const result = await runBatch(run, countingPort, hooks, options(profiles));

  assert.equal(result.outcome.stopped, true);
  assert.equal(result.completed, false);
  assert.match(result.errorMessage ?? '', /^Stopped by you\./);
  assert.equal(summarizeBatchRun(run).generated, 2);
  assert.equal(summarizeBatchRun(run).remaining, 2);
  // Resume depends on this: unstarted builds stay pending, not failed.
  assert.ok(run.builds.filter((b) => b.status === 'pending').length >= 1);
});

test('the run is marked not-in-progress when it ends, so a reload does not auto-resume it', async () => {
  const profiles = makeProfiles(1);
  const run = makeRun({ jobs: [makeJob()], profiles });

  await runBatch(run, fakePort(), recordingHooks(), options(profiles));

  assert.equal(run.inProgress, false);
});

test('builds whose profile is gone are reported, not silently dropped', async () => {
  const profiles = makeProfiles(2);
  const run = makeRun({ jobs: [makeJob()], profiles });
  // The run remembers three profiles; only two are still enabled.
  run.builds.push({ row: 1, profileId: 'p3-removed', status: 'pending' });

  const result = await runBatch(run, fakePort(), recordingHooks(), options(profiles));

  assert.equal(result.outcome.generated, 2);
  assert.equal(result.completed, false);
  assert.match(result.successMessage ?? '', /1 build\(s\) belong to a profile that is no longer enabled/);
});

test('unconfirmed skills are merged across builds, keeping the first spelling', async () => {
  const profiles = makeProfiles(2);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const port = fakePort({
    generate: {
      'Acme:p1': [{ unconfirmedHardSkills: ['Kubernetes'], unconfirmedSoftSkills: ['Ownership'] }],
      'Acme:p2': [{ unconfirmedHardSkills: ['kubernetes', 'Terraform'], unconfirmedSoftSkills: [] }],
    },
  });

  const result = await runBatch(run, port, recordingHooks(), options(profiles));

  assert.deepEqual(result.outcome.unconfirmedHardSkills, ['Kubernetes', 'Terraform']);
  assert.deepEqual(result.outcome.unconfirmedSoftSkills, ['Ownership']);
});

test('with no role input the posting title from the analysis is used', async () => {
  const profiles = makeProfiles(1);
  const run = makeRun({ jobs: [makeJob({ jobTitle: '' })], profiles });
  const port = fakePort();

  await runBatch(run, port, recordingHooks(), options(profiles, { roleFromInput: false }));

  assert.equal(port.calls.generate[0].role, 'Platform Engineer');
});

test('no enabled profiles ends the run early with a message that says what to fix', async () => {
  const run = makeRun({ jobs: [makeJob()], profiles: makeProfiles(1) });

  const result = await runBatch(run, fakePort(), recordingHooks(), options([]));

  assert.equal(result.completed, false);
  assert.equal(result.successMessage, undefined);
  assert.match(result.errorMessage ?? '', /No enabled profiles are loaded/);
  assert.equal(run.inProgress, false);
});

test('progress is reported against the number of builds actually attempted', async () => {
  const profiles = makeProfiles(3);
  const run = makeRun({ jobs: [makeJob()], profiles });
  const hooks = recordingHooks();

  await runBatch(run, fakePort(), hooks, options(profiles));

  assert.ok(hooks.progress.every((p) => p.total === 3));
  assert.equal(hooks.progress.at(-1)?.completed, 3);
  assert.ok(hooks.persistCount > 0);
});
