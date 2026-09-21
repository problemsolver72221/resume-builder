/**
 * CheapAI adapter — https://cheapai.io/v1, an OpenAI-compatible gateway in front of
 * Anthropic, OpenAI, Google and xAI models. Model ids are the catalog's own
 * (https://cheapai.io/models), e.g. claude-haiku-4-5-20251001 or gpt-5.6-luna.
 *
 * Seen live 2026-09-14/15: its Claude models answer as "Claude Code, Anthropic's official
 * CLI", carry that tool's hidden system prompt, and think before answering unless told not
 * to. Sonnet 5 followed the tailoring prompt every time (Haiku refused it once), but spent
 * 6,400–8,000 hidden thinking tokens per call — about 80 s during which the gateway sends
 * nothing, so its Cloudflare front cut every full build off with HTTP 524 at the two-minute
 * mark. With `reasoning_effort: low` the same call answers in about 45 s (Haiku about 27 s)
 * with no thinking tokens; GPT and Gemini ids take the field as their native one.
 */
import type { ReasoningEffort } from 'openai/resources/shared';
import { createReasoningEffortResolver } from '../reasoningEffort';
import { createOpenAiCompatibleAdapter } from './openaiCompatible';

const DEFAULT_TIMEOUT_MS = 3 * 60_000;

export const CHEAPAI_REASONING_EFFORT_ENV = 'CHEAPAI_REASONING_EFFORT';
/** The levels the OpenAI protocol defines; all six were accepted by CheapAI's Claude route on 2026-09-15. */
const REASONING_EFFORTS: readonly NonNullable<ReasoningEffort>[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** CHEAPAI_REASONING_EFFORT when it names a level (any casing), otherwise low. */
export const resolveCheapaiReasoningEffort = createReasoningEffortResolver<NonNullable<ReasoningEffort>>({
  envName: CHEAPAI_REASONING_EFFORT_ENV,
  levels: REASONING_EFFORTS,
  fallback: 'low',
});

function readPositiveNumberEnv(name: string): number | undefined {
  const value = Number(process.env[name]?.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export const cheapaiAdapter = createOpenAiCompatibleAdapter({
  providerId: 'cheapai',
  baseURL: 'https://cheapai.io/v1',
  // A gateway: it takes the classic field and translates for models that want max_completion_tokens.
  maxTokensParam: 'max_tokens',
  // Verified 2026-09-14 on this endpoint: a marked ~8,600-token prefix on Haiku was written
  // once, then read from cache on every later call (usage.prompt_tokens_details.cached_tokens);
  // GPT and Gemini ids accept the same parts and ignore the marker.
  cacheControl: true,
  // A request CheapAI never answers must not hold a build for the SDK's default 10 minutes
  // times three attempts — a 30-minute spinner, seen live. CHEAPAI_TIMEOUT_MS overrides the
  // per-attempt cap. The SDK's own retries are off: the dispatcher retries what is worth
  // retrying with backoff, and a Cloudflare 524 (the model too slow for the request) must
  // not be re-sent — the origin usually completes and bills the first attempt anyway.
  timeoutMs: () => readPositiveNumberEnv('CHEAPAI_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
  maxRetries: 0,
  // Sent on every call — see the header comment: without it Sonnet 5 never finishes in time.
  reasoningEffort: resolveCheapaiReasoningEffort,
});
