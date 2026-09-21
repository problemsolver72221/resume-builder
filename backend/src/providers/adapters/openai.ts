import { createOpenAiCompatibleAdapter } from './openaiCompatible';

export const openaiAdapter = createOpenAiCompatibleAdapter({
  providerId: 'openai',
  maxTokensParam: 'max_completion_tokens',
});
