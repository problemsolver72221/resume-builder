/**
 * Reasoning depth for providers whose API takes one: `reasoning_effort` on you.bot's GPT and
 * Gemini families, and on every CheapAI model. Reasoning tokens are billed as output, the
 * expensive kind, and a tailoring call is a structured rewrite rather than a puzzle, so each
 * provider defaults to its cheapest level; raise it through the provider's env variable for a
 * quality experiment. Each provider names that variable and the levels its API documents —
 * the value is matched in any casing, and an unknown one falls back with a single warning.
 */

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

export interface ReasoningEffortOptions<Level extends string> {
  /** The env variable read when no value is passed explicitly. */
  envName: string;
  levels: readonly Level[];
  fallback: Level;
}

export type ReasoningEffortResolver<Level extends string> = (raw?: string | undefined) => Level;

export function createReasoningEffortResolver<Level extends string>(
  options: ReasoningEffortOptions<Level>
): ReasoningEffortResolver<Level> {
  return (raw: string | undefined = process.env[options.envName]): Level => {
    const wanted = raw?.trim().toLowerCase();
    if (!wanted) return options.fallback;
    const level = options.levels.find((candidate) => candidate.toLowerCase() === wanted);
    if (level) return level;
    warnOnce(`${options.envName}="${raw}" is not one of ${options.levels.join(', ')}; using ${options.fallback}.`);
    return options.fallback;
  };
}
