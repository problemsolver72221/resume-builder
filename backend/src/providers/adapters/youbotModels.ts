/**
 * How each family of you.bot models takes its input.
 *
 * you.bot fronts several vendors' models behind one `/generate` endpoint, but what each
 * accepts differs, verified live on 2026-09-13: `cache_control` markers are honoured by
 * Claude models only (its docs: ignored by the rest); GPT-5.6 Luna refuses the
 * `web_search` field whichever way it is set (`capability_not_supported`); GPT models set
 * their reasoning depth with `reasoning_effort`, not a `thinking` switch, and OpenAI's
 * reasoning models refuse a sampling temperature; and `max_tokens` is applied to Claude
 * models only — Gemini wrote a full essay under a limit of 8, and its `usage.outputTokens`
 * counts hidden thinking, so a "cut off at the limit" check would misfire there.
 *
 * A model id is matched to its family by prefix, so listing a new model of a known family
 * in YOUBOT_MODEL is the whole job; a model from a new vendor, or one model that departs
 * from its family, is one more entry in YOUBOT_MODEL_FAMILIES (first match wins, so put
 * the more specific prefix first).
 */
import { toCacheableContentBlocks } from '../contentBlocks';
import { createReasoningEffortResolver } from '../reasoningEffort';
import { promptText, type TextCompletionRequest } from '../types';

export interface YoubotModelFamily {
  /** Short name, for logs and tests. */
  name: string;
  /** Model-id prefixes that select this family; the first family with a matching prefix wins. */
  prefixes: readonly string[];
  /**
   * Send segmented prompts as content blocks with cache_control breakpoints, so the model
   * reads the stable prefix from cache. Other families get the same text flat, stable part
   * first, which is what vendor-side automatic caching keys on.
   */
  cacheControl: boolean;
  /** Send the request's sampling temperature. Reasoning models reject one. */
  temperature: boolean;
  /**
   * you.bot applies the request's max_tokens to this family. When false the field is not
   * sent and a reply is never judged cut off by it: the vendor's own ceiling applies, and
   * a token count that includes hidden reasoning would otherwise trip that check.
   */
  maxTokens: boolean;
  /** Fields this family understands beyond the common ones, resolved per call. */
  input: (request: TextCompletionRequest) => Record<string, unknown>;
}

export const REASONING_EFFORT_ENV = 'YOUBOT_REASONING_EFFORT';
const REASONING_EFFORTS = ['Low', 'Medium', 'High', 'XHigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Reasoning depth for the families that take one: YOUBOT_REASONING_EFFORT when it names a
 * documented level (any casing), otherwise Low — the cheapest, see ../reasoningEffort.ts.
 */
export const resolveReasoningEffort = createReasoningEffortResolver<ReasoningEffort>({
  envName: REASONING_EFFORT_ENV,
  levels: REASONING_EFFORTS,
  fallback: 'Low',
});

export const YOUBOT_MODEL_FAMILIES: readonly YoubotModelFamily[] = [
  {
    name: 'claude',
    prefixes: ['claude-'],
    cacheControl: true,
    temperature: true,
    maxTokens: true,
    // Extended thinking off — it would spend output tokens a JSON rewrite does not need —
    // and no web search: its results are billed as input tokens.
    input: () => ({ thinking: false, web_search: false }),
  },
  {
    name: 'gpt',
    prefixes: ['gpt-'],
    cacheControl: false,
    temperature: false,
    maxTokens: false,
    // No `web_search` at all: Luna rejects the field whether it is true or false.
    input: () => ({ reasoning_effort: resolveReasoningEffort() }),
  },
  {
    name: 'gemini',
    prefixes: ['gemini-'],
    cacheControl: false,
    temperature: true,
    maxTokens: false,
    // `thinking: false` is accepted but not honoured (a 200-word essay billed 2,477 output
    // tokens); adding a reasoning level cut the hidden part to a quarter in a probe, so
    // both are sent.
    input: () => ({ thinking: false, web_search: false, reasoning_effort: resolveReasoningEffort() }),
  },
];

/** What a model of no listed family gets: only the fields every you.bot chat model documents. */
const GENERIC_FAMILY: YoubotModelFamily = {
  name: 'generic',
  prefixes: [],
  cacheControl: false,
  temperature: true,
  maxTokens: false,
  input: () => ({}),
};

export function resolveYoubotModelFamily(modelId: string): YoubotModelFamily {
  return (
    YOUBOT_MODEL_FAMILIES.find((family) => family.prefixes.some((prefix) => modelId.startsWith(prefix))) ??
    GENERIC_FAMILY
  );
}

export interface YoubotInputOptions {
  /** Mark the stable prefix for caching where the family supports it; YOUBOT_PROMPT_CACHE=0 turns it off. */
  promptCache: boolean;
}

/** The `input` object of a /generate request, shaped for the model's family. */
export function buildYoubotInput(
  request: TextCompletionRequest,
  family: YoubotModelFamily,
  options: YoubotInputOptions
): Record<string, unknown> {
  const blocks = family.cacheControl && options.promptCache ? toCacheableContentBlocks(request.prompt) : null;
  return {
    // `messages` and `prompt` are mutually exclusive. Content blocks let cache_control mark
    // the end of the stable prefix; a plain string keeps the simpler `prompt` form.
    ...(blocks ? { messages: [{ role: 'user', content: blocks }] } : { prompt: promptText(request.prompt) }),
    ...(family.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(family.temperature ? { temperature: request.temperature } : {}),
    // Every call is a stateless one-shot prompt: never let the service append earlier
    // turns, and never stream.
    memory: false,
    stream: false,
    ...family.input(request),
  };
}
