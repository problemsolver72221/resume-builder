import { getProviderApiKey } from '../config/aiModelConfig';
import { extractJsonObject } from '../utils/json';
import { anthropicAdapter } from './adapters/anthropic';
import { openaiAdapter } from './adapters/openai';
import { openrouterAdapter } from './adapters/openrouter';
import { youbotAdapter } from './adapters/youbot';
import { cheapaiAdapter } from './adapters/cheapai';
import {
  getProviderDefinition,
  getProviderMaxOutputTokens,
  toModelSelection,
  type ModelTarget,
  type ProviderId,
} from './registry';
import { getRetryBudgetMs, retryTransient } from './retry';
import type { TextCompletionAdapter, TextCompletionRequest } from './types';
import { ProviderRequestError } from './types';

/** Typed against ProviderId: a registry entry without an adapter is a compile error. */
const ADAPTERS: Record<ProviderId, TextCompletionAdapter> = {
  openai: openaiAdapter,
  claude: anthropicAdapter,
  openrouter: openrouterAdapter,
  youbot: youbotAdapter,
  cheapai: cheapaiAdapter,
};

/**
 * Runs a single-shot text completion on the selected model — or a provider's default when
 * only the provider is named — using its active API key. `request.maxTokens` is a wish; it
 * is clamped to the provider's ceiling.
 */
export async function completeText(target: ModelTarget, request: TextCompletionRequest): Promise<string> {
  const { providerId, model } = toModelSelection(target);
  const definition = getProviderDefinition(providerId);
  const apiKey = await getProviderApiKey(providerId);
  if (!apiKey) {
    throw new ProviderRequestError(providerId, `${definition.label} API key is not set`, undefined, false);
  }

  const maxTokens = Math.min(request.maxTokens, getProviderMaxOutputTokens(providerId));

  // Transient failures — the provider overloaded, rate-limiting, timing out, answering with
  // nothing — are retried with backoff for up to AI_RETRY_BUDGET_MS; a refused request
  // (key, credits, model access, malformed) fails at once. See ./retry.
  return retryTransient(
    () => ADAPTERS[providerId].complete({ ...request, maxTokens }, { providerId, apiKey, model }),
    {
      budgetMs: getRetryBudgetMs(),
      onRetry: ({ attempt, delayMs, remainingMs, error }) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(
          `${definition.label} ${model}: attempt ${attempt} failed (${reason.slice(0, 200)}); retrying in ${Math.round(delayMs / 1000)}s, ${Math.ceil(remainingMs / 60_000)} min of retry budget left.`
        );
      },
    }
  );
}

export interface JsonCompletionOptions {
  /** Total attempts including the first. Each retry is a full, billable model call. */
  maxAttempts?: number;
}

// Each attempt is a paid model call, so this stays bounded even though transport failures
// inside completeText are retried for as long as the budget allows.
const DEFAULT_JSON_ATTEMPTS = 4;

/**
 * Runs a completion that must come back as a JSON object.
 *
 * Models occasionally answer a well-specified JSON prompt with a syntax error or the wrong
 * top-level shape — non-deterministically, so the same prompt usually succeeds on a second
 * try. Because a rejected reply has already been paid for, retrying once costs the same as
 * failing twice and turns most of those into a result. Adapter-level failures (network,
 * auth, a reply that hit the token ceiling) are not retried here: they would fail the same
 * way again, and the adapters already retry what is worth retrying.
 *
 * A reply with no JSON in it at all is different again: the model answered in prose,
 * almost always to decline the task ("I can't build this one as specified…"), and it will
 * decline the same prompt again. That is surfaced at once as a permanent failure, so
 * neither this loop nor the batch above it pays for the same refusal repeatedly.
 */
export async function completeJson<T>(
  target: ModelTarget,
  request: TextCompletionRequest,
  description: string,
  options: JsonCompletionOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_JSON_ATTEMPTS);
  const selection = toModelSelection(target);
  const { providerId } = selection;
  const { label } = getProviderDefinition(providerId);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const content = await completeText(selection, request);

    if (!/[{[]/.test(content)) {
      const firstSentence = (content.trim().match(/^[^.!?]*[.!?]?/) ?? [''])[0].trim().slice(0, 240);
      throw new ProviderRequestError(
        providerId,
        `${label} declined to write ${description}: "${firstSentence}" — try another model, or adjust the profile or the posting.`,
        undefined,
        false,
        // One paid attempt here; but a refusal is not deterministic (Haiku declined one
        // posting in three, then wrote it), so the batch may try again in a later pass.
        true
      );
    }

    try {
      return extractJsonObject<T>(content, description);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `${label} returned an unusable reply for ${description} (attempt ${attempt}/${maxAttempts}): ${lastError.message}`,
        content
      );
    }
  }

  throw lastError ?? new ProviderRequestError(providerId, `${label} returned an unusable reply for ${description}`);
}

export { ProviderRequestError } from './types';
export { classifyFailure, getRetryBudgetMs, retryTransient, RETRY_BUDGET_ENV } from './retry';
export type { FailureVerdict, RetryOptions } from './retry';
export type { TextCompletionAdapter, TextCompletionRequest, ProviderCallContext, CompletionResponseFormat } from './types';
export {
  DEFAULT_PROVIDER_ID,
  PROVIDER_IDS,
  getProviderDefinition,
  UnknownModelError,
  getProviderMaxOutputTokens,
  getProviderModel,
  getProviderModels,
  isProviderId,
  listProviderDefinitions,
  resolveModelSelection,
  resolveProviderId,
  toModelSelection,
} from './registry';
export type { ModelSelection, ModelTarget, ProviderDefinition, ProviderId } from './registry';
