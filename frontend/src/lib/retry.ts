/**
 * Retry passes for the builders.
 *
 * A build that failed for a transient reason — the provider overloaded or down, a timeout,
 * the backend restarting — is tried again, and again, with growing waits between passes,
 * until it succeeds, until its failure turns out to be one only a person can fix (a bad
 * key, no credits, a model the key may not call), until it has used up its attempts, or
 * until the user presses Stop. Builds already on disk are skipped on later passes, so a
 * retry never pays twice. Whatever is left is kept in the saved run for Resume.
 */
import { ApiError } from './api';

/**
 * A connection that dropped or a backend that is restarting is worth another try; the
 * backend says so for the rest. Its "later" verdict (a model too slow for the request just
 * now, a model that declined once) is also worth a pass: the waits between passes are the
 * "later" it asks for.
 */
export function isRetryableFailure(error: unknown): boolean {
  return error instanceof ApiError ? error.retryable || error.retryLater : true;
}

export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Thrown by retryUntilSuccess when the user stopped before the operation succeeded. */
export class StoppedByUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoppedByUserError';
  }
}

const PASS_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000];

/**
 * Attempts one item gets before it is parked for Resume: enough for a provider that is
 * flaky for an hour, few enough that a build that fails the same way every time (a model
 * that keeps declining it) does not hold the batch forever.
 */
export const DEFAULT_MAX_ATTEMPTS = 8;

/** Wait before retry pass `pass` (2 or more): 30 s, 1, 2, 4, 8 min, then 10 min for every later pass. */
export function retryPassDelayMs(pass: number): number {
  return PASS_DELAYS_MS[Math.min(Math.max(pass - 2, 0), PASS_DELAYS_MS.length - 1)];
}

export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Sleeps `ms`, reporting the remaining time every second; resolves false as soon as the user stops. */
export async function waitWithCountdown(
  ms: number,
  hooks: { onTick: (remainingMs: number) => void; isCancelled: () => boolean }
): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (hooks.isCancelled()) return false;
    const remaining = end - Date.now();
    hooks.onTick(Math.max(0, remaining));
    if (remaining <= 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remaining)));
  }
}

export interface RetryFailure<Item> {
  item: Item;
  error: string;
  retryable: boolean;
  /** Attempts made on this item in this run. */
  attempts: number;
}

export interface RetryPassHooks<Item> {
  isCancelled: () => boolean;
  /** Attempts per item before it is parked (default DEFAULT_MAX_ATTEMPTS; 0 or less means no limit). */
  maxAttempts?: number;
  /** Before each item runs: the pass number and the item's position within the pass. */
  onItem?: (item: Item, pass: number, index: number, count: number) => void;
  /** Every second while waiting for the next pass. */
  onWait: (info: { pass: number; remainingMs: number; failures: RetryFailure<Item>[] }) => void;
  /**
   * How long to wait before pass `pass`; defaults to retryPassDelayMs. Only tests pass
   * this, so a suite covering the retry behaviour does not have to sit through the real
   * waits — the backend's retryTransient takes an injected `sleep` for the same reason.
   */
  passDelayMs?: (pass: number) => number;
}

export interface RetryPassOutcome<Item> {
  passes: number;
  /** Failures no retry can fix. */
  permanent: RetryFailure<Item>[];
  /** Retryable failures that used up their attempts; a later Resume tries them again. */
  exhausted: RetryFailure<Item>[];
  /** Retryable failures (and items never started) left because the user stopped. */
  unfinished: RetryFailure<Item>[];
  stopped: boolean;
}

/**
 * Runs every item once, then keeps re-running the ones that failed for a transient reason,
 * waiting longer between passes each time, until none are left, every one has used its
 * attempts, or the user stops.
 */
export async function runWithRetryPasses<Item>(
  items: Item[],
  run: (item: Item, pass: number) => Promise<void>,
  hooks: RetryPassHooks<Item>
): Promise<RetryPassOutcome<Item>> {
  const maxAttempts = hooks.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const permanent: RetryFailure<Item>[] = [];
  const exhausted: RetryFailure<Item>[] = [];
  const attemptsByItem = new Map<Item, number>();
  let pending = items;
  let pass = 1;
  for (;;) {
    const failed: RetryFailure<Item>[] = [];
    const notStarted: Item[] = [];
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      if (hooks.isCancelled()) {
        notStarted.push(...pending.slice(index));
        break;
      }
      hooks.onItem?.(item, pass, index, pending.length);
      const attempts = (attemptsByItem.get(item) ?? 0) + 1;
      attemptsByItem.set(item, attempts);
      try {
        await run(item, pass);
      } catch (error) {
        const retryable = isRetryableFailure(error);
        const failure = { item, error: failureMessage(error, 'Generation failed'), retryable, attempts };
        if (!retryable) permanent.push(failure);
        else if (maxAttempts > 0 && attempts >= maxAttempts) exhausted.push(failure);
        else failed.push(failure);
      }
    }
    if (hooks.isCancelled()) {
      const skipped = notStarted.map((item) => ({
        item,
        error: 'Not started: stopped by you',
        retryable: true,
        attempts: attemptsByItem.get(item) ?? 0,
      }));
      return { passes: pass, permanent, exhausted, unfinished: [...failed, ...skipped], stopped: true };
    }
    if (failed.length === 0) {
      return { passes: pass, permanent, exhausted, unfinished: [], stopped: false };
    }
    pass += 1;
    const waited = await waitWithCountdown((hooks.passDelayMs ?? retryPassDelayMs)(pass), {
      isCancelled: hooks.isCancelled,
      onTick: (remainingMs) => hooks.onWait({ pass, remainingMs, failures: failed }),
    });
    if (!waited) {
      return { passes: pass - 1, permanent, exhausted, unfinished: failed, stopped: true };
    }
    pending = failed.map((failure) => failure.item);
  }
}

/** One operation retried the same way. Throws the permanent error, or StoppedByUserError. */
export async function retryUntilSuccess<T>(
  run: (pass: number) => Promise<T>,
  hooks: {
    isCancelled: () => boolean;
    maxAttempts?: number;
    onWait: (info: { pass: number; remainingMs: number; error: string }) => void;
  }
): Promise<T> {
  let result: T | undefined;
  let done = false;
  const outcome = await runWithRetryPasses(
    [null],
    async (_item, pass) => {
      result = await run(pass);
      done = true;
    },
    {
      isCancelled: hooks.isCancelled,
      maxAttempts: hooks.maxAttempts,
      onWait: ({ pass, remainingMs, failures }) => hooks.onWait({ pass, remainingMs, error: failures[0]?.error ?? '' }),
    }
  );
  if (done) return result as T;
  const failure = outcome.permanent[0] ?? outcome.exhausted[0] ?? outcome.unfinished[0];
  if (outcome.stopped) throw new StoppedByUserError(`Stopped by you. Last failure: ${failure?.error ?? 'none'}`);
  if (outcome.exhausted.length > 0) {
    throw new Error(`Gave up after ${failure?.attempts ?? 0} attempts: ${failure?.error ?? 'Generation failed'}`);
  }
  throw new Error(failure?.error ?? 'Generation failed');
}
