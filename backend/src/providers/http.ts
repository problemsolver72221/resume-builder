import { getProviderDefinition, type ProviderId } from './registry';
import { ProviderRequestError } from './types';

export interface RetryOptions {
  /** Total attempts including the first (default 4). */
  maxAttempts?: number;
  /** Delay before the second attempt; doubles each retry with jitter (default 600ms). */
  baseDelayMs?: number;
  /** Cap on any single delay, including provider Retry-After hints (default 15s). */
  maxDelayMs?: number;
  /** Abort a single attempt after this long. Unset = no per-attempt timeout. */
  timeoutMs?: number;
  /** Test hook; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Statuses to retry in addition to 429 and 5xx, for provider-specific transient codes. */
  alsoRetryStatuses?: readonly number[];
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 600;
const DEFAULT_MAX_DELAY_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Providers usually wrap the useful message in JSON; show that rather than the raw body. */
function describeErrorBody(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const nested = parsed.error && typeof parsed.error === 'object' ? (parsed.error as { message?: unknown }).message : undefined;
    for (const candidate of [parsed.error, parsed.message, nested]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return text.trim().slice(0, 500);
}

/** Rate limits and server-side failures are worth retrying; everything else is the caller's problem. */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(Math.round(retryAfterSeconds * 1000), maxDelayMs);
  }
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.round(Math.random() * 300);
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * fetch + JSON parse with retry on 429/5xx responses and network failures.
 * Throws ProviderRequestError for non-retriable HTTP errors, or once attempts are exhausted.
 */
export async function fetchJsonWithRetry<T>(
  providerId: ProviderId,
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {}
): Promise<T> {
  const { label } = getProviderDefinition(providerId);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isLastAttempt = attempt === maxAttempts;

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isLastAttempt) {
        throw new ProviderRequestError(providerId, `${label} request failed: ${message}`);
      }
      const delay = retryDelayMs(attempt, null, baseDelayMs, maxDelayMs);
      console.warn(`${label} request failed (${message}); attempt ${attempt}/${maxAttempts}, retrying in ${delay}ms.`);
      await sleep(delay);
      continue;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const errorText = await response.text().catch(() => '');
    const retriable = isRetriableStatus(response.status) || options.alsoRetryStatuses?.includes(response.status);
    if (!retriable || isLastAttempt) {
      throw new ProviderRequestError(providerId, `${label} API error (${response.status}): ${describeErrorBody(errorText)}`, response.status);
    }
    const delay = retryDelayMs(attempt, response.headers.get('retry-after'), baseDelayMs, maxDelayMs);
    console.warn(`${label} returned ${response.status} (attempt ${attempt}/${maxAttempts}); retrying in ${delay}ms.`);
    await sleep(delay);
  }

  // Every path above returns or throws on the final attempt; this only satisfies the compiler.
  throw new ProviderRequestError(providerId, `${label} request failed`);
}
