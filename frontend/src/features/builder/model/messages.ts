/**
 * The lines the builder shows when a run ends.
 *
 * They live beside the runner rather than in the component so their exact wording is
 * covered by tests: these sentences are how a user finds out that a six-hour batch left
 * work behind, and which of the three reasons it was.
 */
import { formatCountdown } from '@/lib/retry';
import { describeRunSource, type BatchBuild, type BatchRun, type BatchRunSummary } from '@/lib/batchState';
import type { ImportedSheetJob } from './types';

/** How a job is named in a failure line: a sheet import also gives its row. */
export function describeJob(isImport: boolean, job: ImportedSheetJob | undefined): string {
  if (!job) return 'unknown job';
  return isImport ? `Row ${job.sourceRowNumber} / ${job.companyName}` : job.companyName;
}

export function describeFailure(input: {
  isImport: boolean;
  job: ImportedSheetJob | undefined;
  profileName: string;
  error: string;
}): string {
  return `${describeJob(input.isImport, input.job)} / ${input.profileName}: ${input.error}`;
}

export function describeRetryWait(
  pass: number,
  remainingMs: number,
  failing: number,
  lastError: string
): string {
  return `Retry pass ${pass} in ${formatCountdown(remainingMs)} — still failing (${failing}): ${lastError}`;
}

interface PassResultShape {
  passes: number;
  stopped: boolean;
  permanent: Array<{ item: BatchBuild; error: string }>;
  exhausted: Array<{ item: BatchBuild; error: string }>;
  unfinished: Array<{ item: BatchBuild; error: string }>;
}

export interface RunMessages {
  successMessage: string;
  errorMessage?: string;
}

/** At most three failures are named, then an ellipsis; a long list helps nobody. */
function listed(
  items: Array<{ item: BatchBuild; error: string }>,
  describe: (failure: { item: BatchBuild; error: string }) => string
): string {
  return `${items.slice(0, 3).map(describe).join(' | ')}${items.length > 3 ? ' | ...' : ''}`;
}

export function formatRunMessages(input: {
  run: BatchRun;
  summary: BatchRunSummary;
  passResult: PassResultShape;
  describe: (failure: { item: BatchBuild; error: string }) => string;
  generatedBuilds: number;
  skippedBuilds: number;
  unavailable: number;
  maxAttempts: number;
}): RunMessages {
  const { run, summary, passResult, describe, generatedBuilds, skippedBuilds, unavailable, maxAttempts } = input;

  const notes = [
    skippedBuilds ? `Skipped ${skippedBuilds} build(s) already on disk.` : '',
    run.skippedRows && run.resumeCount === 0
      ? `Skipped ${run.skippedRows} imported row(s) with missing required values.`
      : '',
    passResult.passes > 1 ? `Took ${passResult.passes} passes.` : '',
    unavailable ? `${unavailable} build(s) belong to a profile that is no longer enabled.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const successMessage =
    `Generated ${generatedBuilds} build(s) this run; ${summary.generated + summary.skipped} of ${summary.total}` +
    ` done for the ${describeRunSource(run)}.${notes ? ` ${notes}` : ''}`;

  if (summary.remaining === 0) {
    return { successMessage };
  }

  if (passResult.stopped) {
    return {
      successMessage,
      errorMessage:
        `Stopped by you. ${summary.remaining} build(s) across ${summary.jobsRemaining} job(s) not generated;` +
        ` click Resume to continue. ${listed(passResult.unfinished, describe)}`,
    };
  }

  if (passResult.permanent.length === 0) {
    return {
      successMessage,
      errorMessage:
        `${summary.remaining} build(s) across ${summary.jobsRemaining} job(s) still failed after ${maxAttempts}` +
        ` attempts each and were parked. Click Resume later to try them again, or pick another model first.` +
        ` ${listed(passResult.exhausted, describe)}`,
    };
  }

  return {
    successMessage,
    errorMessage:
      `${summary.remaining} build(s) across ${summary.jobsRemaining} job(s) not generated;` +
      ` ${passResult.permanent.length} failed for reasons a retry cannot fix (key, credits, model access,` +
      ` a malformed request). Fix the cause or pick another model, then click Resume.` +
      ` ${listed([...passResult.permanent, ...passResult.exhausted], describe)}`,
  };
}
