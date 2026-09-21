import type { ProviderId } from './registry';

export type CompletionResponseFormat = 'json' | 'text';

/**
 * One piece of a prompt. A segment marked `cache: true` closes a prefix that is identical
 * across many calls — all the rules, then the per-job data — so providers with prompt
 * caching can serve that prefix from cache instead of re-reading it every time.
 */
export interface PromptSegment {
  text: string;
  cache?: boolean;
}

/** A single-shot, provider-agnostic text completion request. */
export interface TextCompletionRequest {
  /** Plain text, or ordered segments whose stable prefixes a provider may cache. */
  prompt: string | PromptSegment[];
  maxTokens: number;
  temperature: number;
  /** 'json' asks the provider for a bare JSON document where the API supports it. */
  responseFormat: CompletionResponseFormat;
}

/** The prompt as one string, for providers whose API takes flat text. */
export function promptText(prompt: string | PromptSegment[]): string {
  return typeof prompt === 'string' ? prompt : prompt.map((segment) => segment.text).join('');
}

/** Per-call context resolved by the dispatcher and handed to an adapter. */
export interface ProviderCallContext {
  providerId: ProviderId;
  apiKey: string;
  model: string;
}

/** Transport implementation for one provider. */
export interface TextCompletionAdapter {
  complete(request: TextCompletionRequest, context: ProviderCallContext): Promise<string>;
}

export class ProviderRequestError extends Error {
  constructor(
    public readonly providerId: ProviderId,
    message: string,
    public readonly status?: number,
    /** An explicit verdict for callers deciding whether to try again; unset means "judge by status". */
    public readonly retryable?: boolean,
    /**
     * Not worth re-sending within this call (it would repeat, and be billed, right away),
     * but worth a later pass: a model too slow for the request just now, a model that
     * declined once. The builders' retry passes wait minutes between attempts.
     */
    public readonly retryLater?: boolean
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}
