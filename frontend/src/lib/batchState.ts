/**
 * The saved state of a bulk run: its jobs, the analyses already paid for, and the status of
 * every job × profile build. It lives in the browser's localStorage so a run that ended
 * with builds missing — a stopped run, a closed or reloaded tab, failures that needed a
 * person — can be resumed with one click, running only what is not generated and never
 * re-analysing a job whose analysis already succeeded.
 *
 * Every bulk entry point makes one: a Sheets import (many jobs × the chosen profiles) and
 * the manual builder's multi-profile generation (one job × the chosen profiles). Seen
 * live: the manual path used to keep its state in memory only, so a dev-server reload or
 * a discarded tab ended the run with a few resumes built and nothing to resume.
 */
import type { ImportedSheetJob } from '@/features/builder/model/types';
import type { JobAnalysis, TailoredContent } from './api';

export type BatchBuildStatus = 'pending' | 'generated' | 'skipped' | 'failed';
export type BatchRunSource = 'sheets' | 'manual';

export interface BatchBuild {
  /** The job's source row in the sheet, or 1 for a manual run's single job. */
  row: number;
  profileId: string;
  status: BatchBuildStatus;
  error?: string;
  /** For a failed build: whether a later try can succeed. */
  retryable?: boolean;
  /** Attempts made so far across passes and resumes, so a stubborn build is visible. */
  attempts?: number;
  /** Content edited in a preview; a resume reuses it instead of tailoring again. */
  tailoredContent?: TailoredContent;
}

export interface BatchRun {
  id: string;
  startedAt: string;
  updatedAt: string;
  /** The model the run was started with; a resume uses whatever is selected at that time. */
  model: string;
  profiles: Array<{ id: string; name: string }>;
  /** Jobs as imported, job titles already normalised with the builder's fallback role. */
  jobs: ImportedSheetJob[];
  /** Analysis per source row once it succeeded; null when the description was too short to analyse. */
  analyses: Record<string, JobAnalysis | null>;
  builds: BatchBuild[];
  /** Imported rows dropped for missing required values. */
  skippedRows: number;
  /** How many times Resume has been pressed on this run. */
  resumeCount: number;
  /** Date segment of the run's output folder (YYYY-MM-DD), pinned from its first build. */
  outputDate?: string;
  /** Where the run came from. */
  source: BatchRunSource;
  /** Skip builds whose files are already on disk from the first pass on (later passes always do). */
  skipExisting: boolean;
  /**
   * True while the run's loop is alive in some tab. Found true on page load, with builds
   * remaining, it means the loop died without finishing — a reload, a crash, a closed tab.
   */
  inProgress: boolean;
}

const STORAGE_KEY = 'tailor:lastBatchRun';

export function createBatchRun(input: {
  source: BatchRunSource;
  model: string;
  profiles: Array<{ id: string; name: string }>;
  jobs: ImportedSheetJob[];
  skippedRows?: number;
  skipExisting?: boolean;
  /** Analyses already paid for before the run starts (the manual builder analyses first). */
  analyses?: Record<string, JobAnalysis | null>;
  /** Preview edits to build from, per profile id. */
  tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
}): BatchRun {
  const now = new Date().toISOString();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: now,
    updatedAt: now,
    model: input.model,
    profiles: input.profiles,
    jobs: input.jobs,
    analyses: { ...(input.analyses ?? {}) },
    builds: input.jobs.flatMap((job) =>
      input.profiles.map((profile) => {
        const build: BatchBuild = { row: job.sourceRowNumber, profileId: profile.id, status: 'pending' };
        const edited = input.tailoredContentByProfileId?.get(profile.id);
        if (edited) build.tailoredContent = edited;
        return build;
      })
    ),
    skippedRows: input.skippedRows ?? 0,
    resumeCount: 0,
    source: input.source,
    skipExisting: input.skipExisting ?? false,
    inProgress: false,
  };
}

function isBatchRun(value: unknown): value is BatchRun {
  const run = value as Partial<BatchRun> | null;
  return (
    !!run &&
    typeof run.id === 'string' &&
    Array.isArray(run.jobs) &&
    Array.isArray(run.profiles) &&
    Array.isArray(run.builds) &&
    typeof run.analyses === 'object' &&
    run.analyses !== null
  );
}

/** The last saved run, or null when there is none or storage is unavailable. */
export function loadBatchRun(): BatchRun | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isBatchRun(parsed)) return null;
    // Runs saved before these fields existed were all Sheets imports with the skip toggle on.
    return {
      ...parsed,
      resumeCount: typeof parsed.resumeCount === 'number' ? parsed.resumeCount : 0,
      skippedRows: typeof parsed.skippedRows === 'number' ? parsed.skippedRows : 0,
      source: parsed.source === 'manual' ? 'manual' : 'sheets',
      skipExisting: typeof parsed.skipExisting === 'boolean' ? parsed.skipExisting : true,
      inProgress: parsed.inProgress === true,
    };
  } catch {
    return null;
  }
}

/** Saves the run; false when storage refused it (quota, private mode), in which case the run lives on in memory only. */
export function saveBatchRun(run: BatchRun): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(run));
    return true;
  } catch {
    return false;
  }
}

export function clearBatchRun(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear, or storage is unavailable.
  }
}

/** Builds that still need doing: never started, or failed. */
export function remainingBuilds(run: BatchRun): BatchBuild[] {
  return run.builds.filter((build) => build.status === 'pending' || build.status === 'failed');
}

/** A run whose loop died with work left: found still marked in progress after a page load. */
export function wasInterrupted(run: BatchRun): boolean {
  return run.inProgress && remainingBuilds(run).length > 0;
}

/** Short human label for the panel: what the run is building. */
export function describeRunSource(run: BatchRun): string {
  if (run.source === 'manual') {
    const company = run.jobs[0]?.companyName?.trim() || 'one job';
    return `${company} × ${run.profiles.length} profile(s)`;
  }
  return `import of ${run.jobs.length} job(s) × ${run.profiles.length} profile(s)`;
}

export interface BatchRunSummary {
  total: number;
  generated: number;
  skipped: number;
  failed: number;
  pending: number;
  remaining: number;
  /** Distinct jobs with at least one build remaining. */
  jobsRemaining: number;
}

export function summarizeBatchRun(run: BatchRun): BatchRunSummary {
  const count = (status: BatchBuildStatus) => run.builds.filter((build) => build.status === status).length;
  const remaining = remainingBuilds(run);
  return {
    total: run.builds.length,
    generated: count('generated'),
    skipped: count('skipped'),
    failed: count('failed'),
    pending: count('pending'),
    remaining: remaining.length,
    jobsRemaining: new Set(remaining.map((build) => build.row)).size,
  };
}
