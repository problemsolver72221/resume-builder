/**
 * you.bot adapter — https://you.bot/api/v1
 *
 * `POST /generate` runs a model against a single prompt. With `stream: false` the
 * completed text normally comes back inline; if the response only carries a `taskId`
 * the task is polled at `GET /task/{id}?model=...` until text appears or it fails.
 */
import { fetchJsonWithRetry, type RetryOptions } from '../http';
import { buildYoubotInput, resolveYoubotModelFamily } from './youbotModels';
import type { ProviderCallContext, TextCompletionAdapter, TextCompletionRequest } from '../types';
import { ProviderRequestError } from '../types';

const DEFAULT_BASE_URL = 'https://you.bot/api/v1';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TASK_TIMEOUT_MS = 5 * 60_000;

/** Task states after which no text will ever arrive. */
const FAILED_TASK_STATUSES = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'expired']);

/** Task states meaning the job is still running — any text alongside them is partial. */
const PENDING_TASK_STATUSES = new Set(['pending', 'queued', 'processing', 'running', 'in_progress', 'in-progress', 'started']);

type YoubotTaskPayload = {
  taskId?: string;
  text?: string;
  status?: string;
  state?: string;
  error?: string | { message?: string };
  creditsCharged?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
};

/**
 * One line per call so spend is visible in the server log. you.bot reports Anthropic-style
 * usage: inputTokens is the uncached remainder only, and its cache counters stay at zero
 * even on a hit, so the credits figure is the honest signal — a cached call costs a
 * fraction of an uncached one with the same prompt.
 */
function logUsage(payload: YoubotTaskPayload, context: ProviderCallContext): void {
  const usage = payload.usage;
  if (!usage) return;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const credits = typeof payload.creditsCharged === 'number' ? ` — ${payload.creditsCharged.toFixed(2)} credits` : '';
  const cacheNote = cached || written ? ` (cache: ${cached} read, ${written} written)` : '';
  console.log(
    `you.bot ${context.model}: ${usage.inputTokens ?? '?'} uncached in / ${usage.outputTokens ?? '?'} out${credits}${cacheNote}`
  );
}

export interface YoubotAdapterOptions {
  /** Defaults to YOUBOT_BASE_URL, then https://you.bot/api/v1. */
  baseUrl?: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Defaults to YOUBOT_TASK_TIMEOUT_MS, then 5 minutes. */
  taskTimeoutMs?: number;
  retry?: RetryOptions;
  /** Test hook; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function readPositiveNumberEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractText(payload: YoubotTaskPayload): string | null {
  return typeof payload.text === 'string' && payload.text.length > 0 ? payload.text : null;
}

function extractStatus(payload: YoubotTaskPayload): string {
  const raw = typeof payload.status === 'string' ? payload.status : typeof payload.state === 'string' ? payload.state : '';
  return raw.trim().toLowerCase();
}

/**
 * you.bot returns HTTP 200 with the text cut off when a reply reaches `max_tokens`, and
 * carries no finish reason. The only signal is the token count itself, so a reply that
 * used the entire budget is treated as incomplete rather than handed back as if finished.
 * Only families whose max_tokens you.bot enforces get this check (see ./youbotModels):
 * elsewhere the limit was never sent, and the count includes hidden reasoning.
 */
function assertWithinTokenBudget(
  payload: YoubotTaskPayload,
  request: TextCompletionRequest,
  context: ProviderCallContext
): void {
  const outputTokens = payload.usage?.outputTokens;
  if (typeof outputTokens === 'number' && outputTokens >= request.maxTokens) {
    throw new ProviderRequestError(
      context.providerId,
      `you.bot reply was cut off at the ${request.maxTokens}-token output limit; ask for less output or raise maxTokens`
    );
  }
}

/**
 * you.bot refuses a call whose *worst case* cost exceeds the balance, reserving
 * (promptTokens + max_tokens) up front. A run that would really spend ~2 credits is
 * therefore rejected for needing ~14, which reads as nonsense without this context.
 * The reply carries both figures, so the message can say what to actually change.
 */
function explainInsufficientCredits(message: string, maxTokens: number): string | null {
  // The decimal part is matched explicitly so the sentence's closing "." is not captured.
  const match = /cost up to (\d+(?:\.\d+)?).*?balance is (\d+(?:\.\d+)?)/i.exec(message);
  if (!match) return null;

  const need = Number(match[1]);
  const have = Number(match[2]);
  if (!Number.isFinite(need) || !Number.isFinite(have) || need <= 0) return null;

  // Scaling the ceiling by have/need is slightly conservative (the prompt is part of the
  // reservation but does not shrink), which is what we want for a suggested value.
  const suggested = Math.floor((maxTokens * have) / need / 500) * 500;

  return (
    `you.bot declined the request: it reserves the worst-case cost up front, which for a ` +
    `${maxTokens}-token output limit is ${need} credits, and the balance is ${have}. ` +
    `The call itself would have spent roughly ${(need / 7).toFixed(1)}. ` +
    (suggested >= 2000
      ? `Either top up, or set YOUBOT_MAX_OUTPUT_TOKENS=${suggested} to fit the current balance.`
      : `Top up the account — the balance is too low to reserve a usable output limit.`)
  );
}

function extractErrorMessage(payload: YoubotTaskPayload): string {
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  return '';
}

export function createYoubotAdapter(options: YoubotAdapterOptions = {}): TextCompletionAdapter {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async complete(request: TextCompletionRequest, context: ProviderCallContext): Promise<string> {
      // Resolved per call so .env is loaded and tests can override without re-importing.
      const baseUrl = (options.baseUrl ?? (process.env.YOUBOT_BASE_URL?.trim() || DEFAULT_BASE_URL)).replace(/\/+$/, '');
      const taskTimeoutMs =
        options.taskTimeoutMs ?? readPositiveNumberEnv('YOUBOT_TASK_TIMEOUT_MS') ?? DEFAULT_TASK_TIMEOUT_MS;
      const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const maxPollIntervalMs = options.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
      // 409 is you.bot's "duplicate request — wait a moment before retrying", which fires
      // when the same generation is submitted twice (regenerating an unchanged resume).
      // Backing off clears it.
      const retry: RetryOptions = { timeoutMs: taskTimeoutMs, sleep, alsoRetryStatuses: [409], ...options.retry };
      const headers = {
        Authorization: `Bearer ${context.apiKey}`,
        'Content-Type': 'application/json',
      };

      // The prompt's shape depends on the model's family (./youbotModels): Claude models get
      // content blocks whose cache_control marks the stable prefix, every other family the
      // same text flat. Verified 2026-09-13 with a code word buried in the marked prefix:
      // you.bot bills the first call at the cache-write rate (100/M) and later calls sharing
      // the prefix at the cached-input rate (8/M), an 88% cut on that part of the prompt. Do
      // not judge it by `usage`: inputTokens reports only the uncached remainder and the
      // cache counters are never populated, so a hit looks like "16 in" with a much smaller
      // charge. YOUBOT_PROMPT_CACHE=0 sends flat text to every model.
      const family = resolveYoubotModelFamily(context.model);
      const input = buildYoubotInput(request, family, {
        promptCache: process.env.YOUBOT_PROMPT_CACHE !== '0',
      });

      const submit = () => fetchJsonWithRetry<YoubotTaskPayload>(
        context.providerId,
        `${baseUrl}/generate`,
        { method: 'POST', headers, body: JSON.stringify({ modelId: context.model, input }) },
        retry
      );

      let submitted: YoubotTaskPayload;
      try {
        submitted = await submit();
      } catch (error) {
        // Checked structurally rather than with instanceof: this module is reloaded in
        // tests, and a second copy of the error class would silently fail the check.
        const status = error instanceof Error ? (error as { status?: number }).status : undefined;
        if (status === 402) {
          const explained = explainInsufficientCredits((error as Error).message, request.maxTokens);
          if (explained) {
            throw new ProviderRequestError(context.providerId, explained, 402);
          }
        }
        throw error;
      }

      const submittedStatus = extractStatus(submitted);
      const inlineText = extractText(submitted);
      // A sync reply may carry text for a job that is still running; only trust it when the
      // service does not say otherwise. Anything marked pending falls through to polling.
      if (inlineText !== null && !PENDING_TASK_STATUSES.has(submittedStatus)) {
        if (family.maxTokens) assertWithinTokenBudget(submitted, request, context);
        logUsage(submitted, context);
        return inlineText;
      }
      if (FAILED_TASK_STATUSES.has(submittedStatus)) {
        throw new ProviderRequestError(
          context.providerId,
          `you.bot generation ${submittedStatus}: ${extractErrorMessage(submitted) || 'no details'}`
        );
      }

      const taskId = typeof submitted.taskId === 'string' ? submitted.taskId.trim() : '';
      if (!taskId) {
        throw new ProviderRequestError(context.providerId, 'you.bot response contained neither text nor a task id');
      }

      const pollUrl = `${baseUrl}/task/${encodeURIComponent(taskId)}?model=${encodeURIComponent(context.model)}`;
      const deadline = Date.now() + taskTimeoutMs;
      let interval = pollIntervalMs;

      while (Date.now() < deadline) {
        await sleep(interval);
        const task = await fetchJsonWithRetry<YoubotTaskPayload>(context.providerId, pollUrl, { headers }, retry);

        const status = extractStatus(task);
        const text = extractText(task);
        if (text !== null && !PENDING_TASK_STATUSES.has(status)) {
          if (family.maxTokens) assertWithinTokenBudget(task, request, context);
          logUsage(task, context);
          return text;
        }
        if (FAILED_TASK_STATUSES.has(status)) {
          throw new ProviderRequestError(
            context.providerId,
            `you.bot task ${taskId} ${status}: ${extractErrorMessage(task) || 'no details'}`
          );
        }
        interval = Math.min(Math.round(interval * 1.5), maxPollIntervalMs);
      }

      throw new ProviderRequestError(context.providerId, `you.bot task ${taskId} did not complete within ${taskTimeoutMs}ms`);
    },
  };
}

export const youbotAdapter = createYoubotAdapter();
