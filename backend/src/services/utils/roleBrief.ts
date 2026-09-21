/**
 * Clamping for a role's one-paragraph brief.
 *
 * The same backoff — cut at a sentence end, else a comma, else a word boundary, never
 * mid-word and never on a dangling "and" — was written out twice, in the tailoring step
 * and again in the renderer, with the same magic offsets but different caps (900 and
 * 1200). Two constants under one name is how the two quietly stop agreeing, so the
 * algorithm lives here once and each caller passes the cap it actually wants.
 */

/** Below this the tailoring step pads a brief with responsibilities from the posting. */
export const MIN_ROLE_BRIEF_LENGTH = 320;

/**
 * What the tailoring step holds the model's prose to. This is the cap that shapes a
 * tailored resume; the renderer's is only a backstop.
 */
export const TAILORED_ROLE_BRIEF_MAX_LENGTH = 900;

/**
 * The renderer's backstop, deliberately looser than the tailoring cap. Tailored text
 * arrives already clamped to TAILORED_ROLE_BRIEF_MAX_LENGTH, so this only bites on an
 * untailored render, where the text is the profile's own description and truncating it
 * to the tailoring cap would edit what the candidate wrote.
 */
export const RENDERED_ROLE_BRIEF_MAX_LENGTH = 1200;

/**
 * Drops a trailing comma or a dangling conjunction left by a cut.
 *
 * The comma strip runs again after the conjunction, because removing one usually exposes
 * the other: a list cut at "Built pipelines, tooling, and" loses the "and" and would
 * otherwise be left ending on the comma that preceded it. One pass each, in this order,
 * is enough — a conjunction is never exposed by removing a comma.
 */
export function trimIncompleteEnd(value: string): string {
  return value
    .trim()
    .replace(/,+\s*$/, '')
    .replace(/\s+(and|or)\s*$/i, '')
    .replace(/,+\s*$/, '')
    .trim();
}

/**
 * Collapses whitespace and cuts `description` to `maxLength` at the latest clean break,
 * preferring a sentence end, then a comma, then a word boundary. Each break is only taken
 * when it falls near the end of the allowance, so a cut never discards most of the text.
 */
export function clampRoleBrief(description: string, maxLength: number): string {
  const clean = description.trim().replace(/\s+/g, ' ');
  if (clean.length <= maxLength) return trimIncompleteEnd(clean);

  const truncated = clean.slice(0, maxLength);
  let result: string;
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );

  if (lastSentenceEnd >= maxLength - 80) {
    result = truncated.slice(0, lastSentenceEnd + 1).trim();
  } else {
    const lastComma = truncated.lastIndexOf(', ');
    if (lastComma >= maxLength - 50) {
      result = truncated.slice(0, lastComma).trim();
    } else {
      const lastSpace = truncated.trimEnd().lastIndexOf(' ');
      result = lastSpace > 0 && lastSpace >= maxLength - 40
        ? truncated.slice(0, lastSpace).trim()
        : truncated.trimEnd();
    }
  }

  return trimIncompleteEnd(result);
}

/** Appends filler until `text` reaches `minLength`, skipping parts that add nothing. */
export function ensureMinLength(text: string, minLength: number, fillerParts: string[]): string {
  let result = text.trim();
  for (const part of fillerParts) {
    if (result.length >= minLength) break;
    const clean = part.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    result = result ? `${result} ${clean}` : clean;
  }
  return result;
}
