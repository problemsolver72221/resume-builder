/**
 * The batch loop: runs every build of a run that is not generated yet, in retry passes,
 * marking each one as it settles.
 *
 * Analyses are taken from the run when it already has them, so a resumed run never pays
 * twice for a job it already understood. Whatever is still not generated when the passes
 * end — stopped, parked after its attempts, or failed for a reason a retry cannot fix —
 * stays in the run for Resume.
 *
 * This module is deliberately free of React and of the API client. It mutates the
 * `BatchRun` it is given and calls `hooks.persist()` after every change; the caller owns
 * what persisting means and what the UI does with the progress it is handed.
 */
import type { JobAnalysis } from '@shared/types/jobAnalysis';
import {
  DEFAULT_MAX_ATTEMPTS,
  failureMessage,
  isRetryableFailure,
  runWithRetryPasses,
} from '@/lib/retry';
import {
  remainingBuilds,
  summarizeBatchRun,
  type BatchBuild,
  type BatchRun,
} from '@/lib/batchState';
import { describeFailure, describeRetryWait, formatRunMessages } from './messages';
import type {
  BatchOutcome,
  BatchRunResult,
  BuildPort,
  GenerationFailure,
  ImportedSheetJob,
  RunnerHooks,
  RunnerOptions,
} from './types';

/** The posting's own title, when the analysis found one. */
export function getAnalysisJobTitle(analysis?: JobAnalysis): string {
  return analysis?.jobMeta?.title?.trim() ?? '';
}

/** Collects unconfirmed skills across builds, first spelling wins, case-insensitively. */
function collectUnconfirmed(
  target: Map<string, string>,
  skills: string[] | undefined
): void {
  for (const skill of skills ?? []) {
    const key = skill.trim().toLowerCase();
    if (key && !target.has(key)) target.set(key, skill.trim());
  }
}

export async function runBatch(
  run: BatchRun,
  port: BuildPort,
  hooks: RunnerHooks,
  options: RunnerOptions
): Promise<BatchRunResult> {
  const profileById = new Map(options.profiles.map((profile) => [profile.id, profile]));
  const jobByRow = new Map(run.jobs.map((job) => [job.sourceRowNumber, job]));
  const leftover = remainingBuilds(run);
  // A build whose profile was disabled, or whose job left the run, can never be made.
  const todo = leftover.filter((build) => profileById.has(build.profileId) && jobByRow.has(build.row));
  const unavailable = leftover.length - todo.length;
  const totalBuilds = todo.length;
  const isImport = run.source === 'sheets';

  let settledBuilds = 0;
  let skippedBuilds = 0;
  let generatedBuilds = 0;
  const unconfirmedHardMap = new Map<string, string>();
  const unconfirmedSoftMap = new Map<string, string>();

  const profileName = (build: BatchBuild) => profileById.get(build.profileId)?.name ?? build.profileId;
  const describe = (failure: { item: BatchBuild; error: string }) =>
    describeFailure({
      isImport,
      job: jobByRow.get(failure.item.row),
      profileName: profileName(failure.item),
      error: failure.error,
    });
  const toFailure = (failure: { item: BatchBuild; error: string; retryable: boolean }): GenerationFailure => ({
    profileId: failure.item.profileId,
    profileName: profileName(failure.item),
    companyName: jobByRow.get(failure.item.row)?.companyName ?? '',
    error: failure.error,
    retryable: failure.retryable,
  });

  // A failed analysis is not re-run for the job's other profiles within the same pass.
  const analysisFailureByRow = new Map<number, { pass: number; error: unknown }>();
  const getAnalysis = async (job: ImportedSheetJob, pass: number): Promise<JobAnalysis | undefined> => {
    const key = String(job.sourceRowNumber);
    if (key in run.analyses) return run.analyses[key] ?? undefined;
    const earlier = analysisFailureByRow.get(job.sourceRowNumber);
    if (earlier && earlier.pass === pass) throw earlier.error;

    const trimmed = job.jobDescription.trim();
    const jobIndex = run.jobs.indexOf(job);
    hooks.onStep(
      `${pass > 1 ? `Retry pass ${pass} — ` : ''}Analyzing ${job.companyName} (${jobIndex + 1}/${run.jobs.length})`
    );
    hooks.onProgress({
      total: totalBuilds,
      completed: settledBuilds,
      phase: 'Analyzing job',
      currentCompanyName: job.companyName.trim(),
    });

    try {
      // Too short to analyse is recorded as null, not absent, so a resume does not retry it.
      const analysis = trimmed.length >= 50 ? await port.analyze(trimmed, run.model) : null;
      run.analyses[key] = analysis;
      hooks.persist();
      if (analysis) hooks.onAnalysis?.(analysis);
      return analysis ?? undefined;
    } catch (error) {
      analysisFailureByRow.set(job.sourceRowNumber, { pass, error });
      throw error;
    }
  };

  let outcome: BatchOutcome = {
    generated: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    failedCompanies: [],
    stopped: false,
    passes: 0,
    remaining: leftover.length,
    unconfirmedHardSkills: [],
    unconfirmedSoftSkills: [],
  };
  let successMessage: string | undefined;
  let errorMessage: string | undefined;
  let completed = false;

  // Found still true on the next page load, it tells that load the loop died mid-run.
  run.inProgress = true;
  hooks.persist();

  try {
    if (options.profiles.length === 0) {
      throw new Error('No enabled profiles are loaded; check Admin > Profiles, then resume.');
    }
    hooks.onProgress({
      total: totalBuilds,
      completed: 0,
      phase: run.resumeCount > 0 ? 'Resuming builds' : 'Preparing builds',
    });

    const passResult = await runWithRetryPasses(
      todo,
      async (build, pass) => {
        const job = jobByRow.get(build.row)!;
        const profile = profileById.get(build.profileId)!;
        build.attempts = (build.attempts ?? 0) + 1;
        try {
          // Later passes and resumes always skip finished builds: a retry must never pay twice.
          const skipExisting = pass > 1 || run.resumeCount > 0 || run.skipExisting;
          if (skipExisting) {
            // Files already on disk settle the build without an analysis or a model call.
            const { exists } = await port.checkExisting({
              profileId: profile.id,
              companyName: job.companyName.trim(),
              role: job.jobTitle.trim(),
              ...options.generationOptions,
              outputDate: run.outputDate,
            });
            if (exists) {
              skippedBuilds += 1;
              settledBuilds += 1;
              Object.assign(build, { status: 'skipped', error: undefined, retryable: undefined });
              hooks.persist();
              hooks.onProgress({
                total: totalBuilds,
                completed: settledBuilds,
                phase: 'Building resumes',
                currentProfileName: profile.name,
                currentCompanyName: job.companyName.trim(),
              });
              return;
            }
          }

          const analysis = await getAnalysis(job, pass);
          const result = await port.generate({
            profileId: profile.id,
            templateId: profile.preferredTemplate || 'default',
            jobDescription: job.jobDescription.trim(),
            jobAnalysis: analysis,
            // Edits made in a preview travel with the build, so a resume does not tailor again.
            tailoredContent: build.tailoredContent,
            companyName: job.companyName.trim(),
            role: options.roleFromInput
              ? job.jobTitle.trim()
              : job.jobTitle.trim() || getAnalysisJobTitle(analysis) || '',
            model: run.model,
            ...options.generationOptions,
            skipExisting,
            outputDate: run.outputDate,
          });

          // The first build settles the folder date for the whole run.
          if (!run.outputDate && result.outputDate) run.outputDate = result.outputDate;
          if (result.skipped) skippedBuilds += 1;
          else generatedBuilds += 1;
          settledBuilds += 1;
          collectUnconfirmed(unconfirmedHardMap, result.unconfirmedHardSkills);
          collectUnconfirmed(unconfirmedSoftMap, result.unconfirmedSoftSkills);
          Object.assign(build, {
            status: result.skipped ? 'skipped' : 'generated',
            error: undefined,
            retryable: undefined,
          });
          hooks.persist();
          hooks.onProgress({
            total: totalBuilds,
            completed: settledBuilds,
            phase: 'Building resumes',
            currentProfileName: profile.name,
            currentCompanyName: job.companyName.trim(),
          });
        } catch (error) {
          Object.assign(build, {
            status: 'failed',
            error: failureMessage(error, 'Generation failed'),
            retryable: isRetryableFailure(error),
          });
          hooks.persist();
          throw error;
        }
      },
      {
        isCancelled: hooks.isCancelled,
        maxAttempts: options.maxAttempts,
        passDelayMs: options.passDelayMs,
        onItem: (build, pass, index, count) => {
          const job = jobByRow.get(build.row)!;
          hooks.onStep(
            `${pass > 1 ? `Retry pass ${pass} — ` : ''}Generating ${index + 1}/${count}: ${profileName(build)} x ${job.companyName}`
          );
          hooks.onProgress({
            total: totalBuilds,
            completed: settledBuilds,
            phase: pass > 1 ? `Building resumes (retry pass ${pass})` : 'Building resumes',
            currentProfileName: profileName(build),
            currentCompanyName: job.companyName.trim(),
          });
        },
        onWait: ({ pass, remainingMs, failures }) =>
          hooks.onStep(describeRetryWait(pass, remainingMs, failures.length, describe(failures[0]))),
      }
    );

    const summary = summarizeBatchRun(run);
    const failures = [...passResult.permanent, ...passResult.exhausted, ...passResult.unfinished].map(toFailure);
    outcome = {
      generated: generatedBuilds,
      skipped: skippedBuilds,
      failed: failures.length,
      failures,
      failedCompanies: [...new Set(failures.map((failure) => failure.companyName).filter(Boolean))],
      stopped: passResult.stopped,
      passes: passResult.passes,
      remaining: summary.remaining,
      unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
    };

    const messages = formatRunMessages({
      run,
      summary,
      passResult,
      describe,
      generatedBuilds,
      skippedBuilds,
      unavailable,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
    successMessage = messages.successMessage;
    errorMessage = messages.errorMessage;
    completed = summary.remaining === 0;
  } catch (err) {
    // Per-build errors are handled inside the passes; anything landing here ended the run
    // early. The run is saved, so Resume continues from where it stopped.
    errorMessage = `The run stopped after ${settledBuilds}/${totalBuilds} build(s): ${
      err instanceof Error ? err.message : 'unexpected error'
    }. Click Resume to continue from where it stopped.`;
  } finally {
    run.inProgress = false;
    if (remainingBuilds(run).length > 0) hooks.persist();
  }

  return { outcome, successMessage, errorMessage, completed };
}
