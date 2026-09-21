import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import { toCacheableContentBlocks, type CacheableContentBlock } from '../contentBlocks';
import { getProviderDefinition, type ProviderId } from '../registry';
import type { ProviderCallContext, TextCompletionAdapter, TextCompletionRequest } from '../types';
import { ProviderRequestError, promptText } from '../types';

const JSON_SYSTEM_PROMPT =
  'You are a strict JSON generator. Return valid JSON only, with no markdown fences or extra text.';

export interface OpenAiCompatibleOptions {
  providerId: ProviderId;
  /** Omit for api.openai.com. */
  baseURL?: string;
  /** Extra headers for every request; resolved lazily so .env is loaded first. */
  defaultHeaders?: () => Record<string, string>;
  /** Current OpenAI models only accept `max_completion_tokens`; most compatible gateways still expect `max_tokens`. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /**
   * Send a segmented prompt as content parts whose `cache_control` marks the end of each
   * stable prefix — the Anthropic convention, which a gateway such as CheapAI passes through
   * to Claude models (verified 2026-09-14: a marked prefix was written once, then read from
   * cache on every later call) and other models accept and ignore. Off by default:
   * api.openai.com caches identical prefixes on its own and a flat string is the documented shape.
   */
  cacheControl?: boolean;
  /** Per-attempt request timeout, resolved lazily so .env is loaded first. Default: the SDK's 10 minutes. */
  timeoutMs?: () => number | undefined;
  /** Attempts after a failed or timed-out one (default: the SDK's 2). */
  maxRetries?: number;
  /**
   * Reasoning depth sent as `reasoning_effort`, resolved per call so .env is loaded first.
   * Omit to leave the model at its default. A gateway may need it even for models that do
   * not take the field natively: CheapAI's Claude models think at length unless it is `low`
   * (verified 2026-09-15: Sonnet 5 spent 6,400–8,000 hidden thinking tokens per tailoring
   * call, sent nothing for about 80 s, and its Cloudflare front cut the request off).
   */
  reasoningEffort?: () => ReasoningEffort | undefined;
}

type UsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** CheapAI attaches the Anthropic accounting for its Claude models. */
  billing_usage?: { claude_usage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
};

/** One line per call, like the you.bot adapter's, so spend and cache hits are visible in the server log. */
function logUsage(label: string, model: string, usage: UsageLike | undefined): void {
  if (!usage) return;
  const claude = usage.billing_usage?.claude_usage;
  const read = claude?.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const written = claude?.cache_creation_input_tokens ?? 0;
  const cacheNote = read || written ? ` (cache: ${read} read, ${written} written)` : '';
  console.log(`${label} ${model}: ${usage.prompt_tokens ?? '?'} in / ${usage.completion_tokens ?? '?'} out${cacheNote}`);
}

export interface ChatMessageOptions {
  /** See OpenAiCompatibleOptions.cacheControl. */
  cacheControl?: boolean;
}

export type ChatMessage = { role: 'system' | 'user'; content: string | CacheableContentBlock[] };

export function buildChatMessages(request: TextCompletionRequest, options: ChatMessageOptions = {}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (request.responseFormat === 'json') {
    messages.push({ role: 'system', content: JSON_SYSTEM_PROMPT });
  }
  // Segments stay in order either way, which is all api.openai.com's automatic prefix
  // caching needs. Gateways that front Claude models want the Anthropic convention on top:
  // content parts whose cache_control marks the end of each stable prefix.
  const blocks = options.cacheControl ? toCacheableContentBlocks(request.prompt) : null;
  messages.push({ role: 'user', content: blocks ?? promptText(request.prompt) });
  return messages;
}

/** Adapter for any service that speaks the OpenAI chat-completions protocol. */
export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): TextCompletionAdapter {
  const { label } = getProviderDefinition(options.providerId);

  // One client per API key: the active key can change at runtime through admin settings.
  let client: OpenAI | null = null;
  let clientKey = '';
  const getClient = (apiKey: string): OpenAI => {
    if (!client || clientKey !== apiKey) {
      client = new OpenAI({
        apiKey,
        baseURL: options.baseURL,
        defaultHeaders: options.defaultHeaders?.(),
        timeout: options.timeoutMs?.(),
        maxRetries: options.maxRetries,
        // Resolved per call rather than captured at construction, so a fetch swapped in later
        // (tests, instrumentation) is honoured by the cached client.
        fetch: (url, init) => globalThis.fetch(url, init),
      });
      clientKey = apiKey;
    }
    return client;
  };

  return {
    async complete(request: TextCompletionRequest, context: ProviderCallContext): Promise<string> {
      const tokenLimit =
        options.maxTokensParam === 'max_completion_tokens'
          ? { max_completion_tokens: request.maxTokens }
          : { max_tokens: request.maxTokens };

      const reasoningEffort = options.reasoningEffort?.();

      let response;
      try {
        response = await getClient(context.apiKey).chat.completions.create({
        model: context.model,
        ...tokenLimit,
        temperature: request.temperature,
        top_p: 1,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' as const } } : {}),
        messages: buildChatMessages(request, { cacheControl: options.cacheControl }),
        });
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status === 524) {
          throw new ProviderRequestError(
            options.providerId,
            `${label} gave up waiting for ${context.model} after about two minutes (HTTP 524): this model is too slow for a request this size on this provider right now. Try again later, or use another model.`,
            524,
            false,
            // Not re-sent within this call (the origin usually finishes and bills the first
            // attempt anyway), but load-dependent: the same build often succeeds minutes later.
            true
          );
        }
        throw error;
      }

      logUsage(label, context.model, response.usage as UsageLike | undefined);
      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new ProviderRequestError(options.providerId, `Unexpected response from ${label}`);
      }
      return content;
    },
  };
}
