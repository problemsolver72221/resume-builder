import { createOpenAiCompatibleAdapter } from './openaiCompatible';

export const openrouterAdapter = createOpenAiCompatibleAdapter({
  providerId: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  maxTokensParam: 'max_tokens',
  // OpenRouter uses these to attribute traffic on its dashboard.
  defaultHeaders: () => ({
    'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3001',
    'X-Title': process.env.OPENROUTER_APP_NAME || 'Tailored Resume Builder',
  }),
});
