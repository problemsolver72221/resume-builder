/**
 * Keeps an AI call going through transient failures, and tells apart the failures worth
 * waiting out from the ones that will repeat until a person acts.
 *
 * A provider that is rate-limiting, overloaded, timing out, or answering with nothing is
 * worth another try: the same request usually succeeds a little later, and a request the
 * provider refused or never answered is not charged. A provider that rejects the request —
 * bad key, no credits, a model the key may not call, a malformed request — will reject it
 * again, so those fail at once. The verdict travels with every failure as `retryable`, so
 * the batch running in the browser can make the same call at its own level.
 */
export interface FailureVerdict {
  retryable: boolean;
  /**
   * Not worth re-sending within the call, but worth a later pass by the batch in the
   * browser: a model too slow for the request just now, a model that declined once.
   */
  retryLater?: boolean;
  status?: number;
}

/** Statuses a later attempt can clear: timeouts, duplicates, empty replies, early requests, rate limits. */
const TRANSIENT_STATUSES = new Set([408, 409, 422, 425, 429]);

function readStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function classifyFailure(error: unknown): FailureVerdict {
  // Checked structurally rather than with instanceof: provider modules are reloaded in
  // tests, and a second copy of an error class would silently fail the check.
  const verdict = (error as { retryable?: unknown } | null)?.retryable;
  if (typeof verdict === 'boolean') {
    const later = (error as { retryLater?: unknown }).retryLater === true;
    return later ? { retryable: verdict, retryLater: true, status: readStatus(error) } : { retryable: verdict, status: readStatus(error) };
  }
  if ((error as { name?: unknown } | null)?.name === 'UnknownModelError') return { retryable: false };
  const status = readStatus(error);
  if (typeof status === 'number') {
    // 524 is Cloudflare giving up on an origin that took too long for this request. Sent
    // again at once it takes just as long (and the origin usually finishes and bills the
    // first attempt anyway), so it is never re-sent within the call — but it is load-bound,
    // seen live with Sonnet 5 on CheapAI, so a pass minutes later is worth it.
    if (status === 524) return { retryable: false, retryLater: true, status };
    if (status >= 500 || TRANSIENT_STATUSES.has(status)) return { retryable: true, status };
    if (status >= 400) return { retryable: false, status };
  }
  // No status: a dropped connection, a timeout, a reply with no text or unusable JSON, a
  // reply cut off at the token limit — the provider having a bad moment.
  return { retryable: true, status };
}

export interface RetryOptions {
  /** How long after the first failure the call may keep retrying; 0 disables retries. */
  budgetMs: number;
  /** Delay before the second attempt; doubles each time up to maxDelayMs (defaults 2 s and 60 s). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Random extra delay so parallel batches do not retry in lockstep (default: up to 500 ms). */
  jitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; remainingMs: number; error: unknown }) => void;
}

/** Runs `run` until it succeeds, a permanent failure occurs, or the next wait would overrun the budget. */
export async function retryTransient<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const jitterMs = options.jitterMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs) + Math.round(Math.random() * jitterMs);
      const remainingMs = options.budgetMs - (now() - started);
      if (!classifyFailure(error).retryable || delayMs > remainingMs) throw error;
      options.onRetry?.({ attempt, delayMs, remainingMs: remainingMs - delayMs, error });
      await sleep(delayMs);
    }
  }
}

export const RETRY_BUDGET_ENV = 'AI_RETRY_BUDGET_MS';
const DEFAULT_RETRY_BUDGET_MS = 10 * 60_000;

/** Retry budget for one AI call: AI_RETRY_BUDGET_MS when it is a non-negative number, else 10 minutes. */
export function getRetryBudgetMs(): number {
  const raw = process.env[RETRY_BUDGET_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RETRY_BUDGET_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_BUDGET_MS;
}
