import type { PromptSegment } from './types';

/**
 * Anthropic-style content blocks, used directly by the Anthropic API and by you.bot's
 * `input.messages` passthrough for Claude models.
 */
export interface CacheableContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Anthropic honours at most this many cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Turns prompt segments into content blocks, marking each cached segment's end with
 * `cache_control` so the model can read that prefix from cache on later requests.
 *
 * Only the last few breakpoints are honoured, so when a caller marks more than the limit
 * the earliest are dropped — keeping the longest prefixes, which are the valuable ones.
 * Returns null for a plain string, letting callers use their simpler flat-text path.
 */
export function toCacheableContentBlocks(prompt: string | PromptSegment[]): CacheableContentBlock[] | null {
  if (typeof prompt === 'string') return null;

  let breakpointsLeft = MAX_CACHE_BREAKPOINTS;
  const blocks: CacheableContentBlock[] = [];
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const segment = prompt[index];
    const cache = Boolean(segment.cache) && breakpointsLeft > 0;
    if (cache) breakpointsLeft -= 1;
    blocks.unshift({
      type: 'text',
      text: segment.text,
      ...(cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    });
  }
  return blocks;
}
