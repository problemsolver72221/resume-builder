/**
 * Fakes for the builder model's tests.
 *
 * The point of the BuildPort is that the batch loop can be driven without a backend, a
 * browser or a clock. `fakePort` records every call and lets each one be scripted per
 * build, so a test can say "this profile fails twice with a retryable error, then works".
 */
import type {
  BuildPort,
  ExistingCheckInput,
  GenerateInput,
  GenerateOutcome,
  ImportedSheetJob,
  RunnerHooks,
  RunnerProfile,
} from '../src/features/builder/model/types';
import type { JobAnalysis } from '../../shared/types/jobAnalysis';
import { ApiError } from '../src/lib/api';
import { createBatchRun, type BatchRun } from '../src/lib/batchState';

export function makeAnalysis(title = 'Platform Engineer'): JobAnalysis {
  return {
    jobMeta: { title, seniority: 'Senior', industry: 'Software', department: 'Engineering' },
    skills: { required: [], preferred: [], tools: [], technologies: [] },
    responsibilities: [],
    domainKnowledge: [],
    softSkills: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  };
}

export function makeJob(overrides: Partial<ImportedSheetJob> = {}): ImportedSheetJob {
  return {
    sourceRowNumber: 1,
    companyName: 'Acme',
    jobTitle: 'Platform Engineer',
    // Long enough to clear the 50-character floor that decides whether a job is analysed.
    jobDescription: 'We need a platform engineer to run our Kubernetes estate and CI pipelines.',
    ...overrides,
  };
}

export function makeProfiles(count: number): RunnerProfile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Profile ${index + 1}`,
  }));
}

export function makeRun(input: {
  jobs: ImportedSheetJob[];
  profiles: RunnerProfile[];
  skipExisting?: boolean;
  source?: 'sheets' | 'manual';
  analyses?: Record<string, JobAnalysis | null>;
}): BatchRun {
  return createBatchRun({
    source: input.source ?? 'sheets',
    model: 'cheapai/claude-sonnet-5',
    profiles: input.profiles.map((p) => ({ id: p.id, name: p.name })),
    jobs: input.jobs,
    skipExisting: input.skipExisting ?? false,
    analyses: input.analyses,
  });
}

/**
 * A failure as the API client actually raises it.
 *
 * It has to be a real ApiError: isRetryableFailure narrows with `instanceof`, so a plain
 * Error with the same fields on it is treated as an unknown failure and retried.
 */
export function failure(message: string, retryable: boolean): Error {
  return new ApiError(message, retryable ? 503 : 402, retryable);
}

export interface PortScript {
  /** Keyed "<row>:<profileId>"; each call shifts the next entry off. */
  generate?: Record<string, Array<GenerateOutcome | Error>>;
  analyze?: Record<string, Array<JobAnalysis | Error>>;
  existing?: Record<string, boolean[]>;
}

export interface RecordingPort extends BuildPort {
  calls: {
    existing: ExistingCheckInput[];
    analyze: Array<{ jobDescription: string; model: string }>;
    generate: GenerateInput[];
  };
}

function next<T>(queue: T[] | undefined, fallback: T): T {
  if (!queue || queue.length === 0) return fallback;
  return queue.length === 1 ? queue[0] : (queue.shift() as T);
}

export function fakePort(script: PortScript = {}): RecordingPort {
  const calls: RecordingPort['calls'] = { existing: [], analyze: [], generate: [] };
  return {
    calls,
    async checkExisting(input) {
      calls.existing.push(input);
      const queue = script.existing?.[`${input.companyName}:${input.profileId}`];
      return { exists: next(queue, false) };
    },
    async analyze(jobDescription, model) {
      calls.analyze.push({ jobDescription, model });
      const result = next(script.analyze?.[jobDescription], makeAnalysis());
      if (result instanceof Error) throw result;
      return result;
    },
    async generate(input) {
      calls.generate.push(input);
      const key = `${input.companyName}:${input.profileId}`;
      const result = next(script.generate?.[key], { outputDate: '2026-04-10' });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export interface RecordingHooks extends RunnerHooks {
  steps: string[];
  progress: Array<{ phase: string; completed: number; total: number }>;
  analyses: JobAnalysis[];
  persistCount: number;
}

export function recordingHooks(isCancelled: () => boolean = () => false): RecordingHooks {
  const hooks: RecordingHooks = {
    steps: [],
    progress: [],
    analyses: [],
    persistCount: 0,
    isCancelled,
    persist: () => {
      hooks.persistCount += 1;
    },
    onStep: (message) => {
      hooks.steps.push(message);
    },
    onProgress: (p) => {
      hooks.progress.push({ phase: p.phase, completed: p.completed, total: p.total });
    },
    onAnalysis: (analysis) => {
      hooks.analyses.push(analysis);
    },
  };
  return hooks;
}
