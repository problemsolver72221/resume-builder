import { fetchJsonWithRetry } from '../http';
import { toCacheableContentBlocks } from '../contentBlocks';
import type { ProviderCallContext, TextCompletionAdapter, TextCompletionRequest } from '../types';
import { ProviderRequestError, promptText } from '../types';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

type AnthropicMessagesResponse = {
  content?: Array<{ type: string; text?: string }>;
};

/** Direct Anthropic Messages API. It has no JSON mode, so callers parse the text they get back. */
export const anthropicAdapter: TextCompletionAdapter = {
  async complete(request: TextCompletionRequest, context: ProviderCallContext): Promise<string> {
    const data = await fetchJsonWithRetry<AnthropicMessagesResponse>(context.providerId, MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': context.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: context.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        messages: [
          { role: 'user', content: toCacheableContentBlocks(request.prompt) ?? promptText(request.prompt) },
        ],
      }),
    });

    const textBlock = data.content?.find((block) => block.type === 'text' && typeof block.text === 'string');
    if (!textBlock?.text) {
      throw new ProviderRequestError(context.providerId, 'Unexpected response from Anthropic');
    }
    return textBlock.text;
  },
};
