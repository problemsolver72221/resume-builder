/**
 * Contracts for the builder's batch model.
 *
 * Everything in `model/` is framework-free on purpose: no React, no fetch, no imports from
 * `components/`. The batch loop is the most intricate logic in the app and was previously
 * a closure over a dozen pieces of component state, which made it untestable. Expressed
 * against these ports it runs the same way under `node --test` with fakes as it does in a
 * browser against the real API.
 */
import type { JobAnalysis } from '@shared/types/jobAnalysis';
import type { ResumeFormat } from '@shared/types/resume';
import type { TailoredContent } from '@/lib/api';

/**
 * One job to build against. Declared here rather than in the Sheets modal that happens to
 * produce it: the model may not depend on a component, and the manual builder synthesises
 * one of these too.
 */
export type ImportedSheetJob = {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  /** Row in the source sheet, or 1 for a manual run's single job. */
  sourceRowNumber: number;
};

/** The options every build in a run shares, as the builder's toggles settle them. */
export interface GenerationOptions {
  format: ResumeFormat;
  includeCoverLetterDocx: boolean;
  includeCoverLetter: boolean;
}

/** What the runner reads back from a completed build; the API returns more than this. */
export interface GenerateOutcome {
  skipped?: boolean;
  outputDate?: string;
  unconfirmedHardSkills?: string[];
  unconfirmedSoftSkills?: string[];
}

export interface ExistingCheckInput extends GenerationOptions {
  profileId: string;
  companyName: string;
  role: string;
  outputDate?: string;
}

export interface GenerateInput extends GenerationOptions {
  profileId: string;
  templateId: string;
  jobDescription: string;
  jobAnalysis?: JobAnalysis;
  tailoredContent?: TailoredContent;
  companyName: string;
  role: string;
  model: string;
  skipExisting: boolean;
  outputDate?: string;
}

/** The three backend calls a batch makes. Fakeable in full, which is the point. */
export interface BuildPort {
  checkExisting(input: ExistingCheckInput): Promise<{ exists: boolean; outputDate?: string }>;
  analyze(jobDescription: string, model: string): Promise<JobAnalysis>;
  generate(input: GenerateInput): Promise<GenerateOutcome>;
}

/** Progress as the runner reports it; the component turns this into its progress bar. */
export interface RunProgress {
  total: number;
  completed: number;
  phase: string;
  currentProfileName?: string;
  currentCompanyName?: string;
}

/** Everything the runner pushes outward. None of it decides what the runner does next. */
export interface RunnerHooks {
  /** Checked between builds and while waiting for the next pass. */
  isCancelled(): boolean;
  /** Called after every mutation of the run, so a killed tab loses nothing. */
  persist(): void;
  onStep(message: string): void;
  onProgress(progress: RunProgress): void;
  /**
   * Every analysis the run pays for, in order. The caller decides whether to surface it —
   * the builder only does so when it had none when the run started.
   */
  onAnalysis?(analysis: JobAnalysis): void;
}

/** A profile as the runner needs it; the full Profile carries far more. */
export interface RunnerProfile {
  id: string;
  name: string;
  preferredTemplate?: string;
}

export interface RunnerOptions {
  profiles: RunnerProfile[];
  generationOptions: GenerationOptions;
  /**
   * True when the builder shows a Role field, which means the job's own title is used
   * verbatim; false lets the analysis supply a title the posting did not spell out.
   */
  roleFromInput: boolean;
  /** Attempts per build before it is parked for Resume; defaults to DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: number;
  /**
   * How long to wait between retry passes; defaults to the real schedule (30 s, 1, 2, 4,
   * 8, then 10 minutes). Only tests set it, so covering the retry behaviour does not mean
   * sitting through the waits.
   */
  passDelayMs?: (pass: number) => number;
}

export interface GenerationFailure {
  profileId: string;
  profileName: string;
  companyName: string;
  error: string;
  /** False when no retry can fix it: a bad key, no credits, a model the key may not call. */
  retryable: boolean;
}

/** What a bulk run reports when its passes end, whichever builder started it. */
export interface BatchOutcome {
  generated: number;
  skipped: number;
  failed: number;
  failures: GenerationFailure[];
  failedCompanies: string[];
  stopped: boolean;
  passes: number;
  /** Builds still not generated, kept in the saved run for Resume. */
  remaining: number;
  unconfirmedHardSkills: string[];
  unconfirmedSoftSkills: string[];
}

/**
 * The runner's full result: the outcome plus the lines the builder shows. The messages are
 * produced here rather than in the component so their exact wording is covered by tests.
 */
export interface BatchRunResult {
  outcome: BatchOutcome;
  /** The summary line, present whenever the passes ran to completion. */
  successMessage?: string;
  /** The problem line, present when work is left or the run ended early. */
  errorMessage?: string;
  /** Every build settled: the caller should drop the saved run. */
  completed: boolean;
}
