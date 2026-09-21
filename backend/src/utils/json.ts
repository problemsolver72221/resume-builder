/**
 * Pulls the JSON document out of a model reply, which may arrive bare, wrapped in a
 * ```json fence, or surrounded by prose.
 *
 * The one thing this must never do is return a *fragment*. Every caller wants the whole
 * payload, and a JSON document is full of smaller documents that parse perfectly well on
 * their own — so a naive scan can succeed while returning something entirely wrong.
 * Two ways that happens, both seen in production:
 *
 *   - The reply is cut off mid-document. The outer object never closes, but the objects
 *     nested in it do.
 *   - The reply is complete but contains a syntax error (an unescaped character inside a
 *     long string, say). The outer object balances yet fails to parse, while the arrays
 *     and objects inside it parse fine.
 *
 * In both cases the caller would receive, for example, a bare experience array and treat
 * it as an entire tailored resume — silently losing every other field. So the scan
 * refuses to descend into a structure it could not parse, and refuses to return anything
 * at all once it sees the document is incomplete.
 */

function tryParseJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

type BalanceScan =
  /** Structures opened and closed cleanly; `end` is the index of the closing bracket. */
  | { kind: 'balanced'; candidate: string; end: number }
  /** A closing bracket did not match its opener, so this start is not a JSON document. */
  | { kind: 'mismatch' }
  /** Input ended while structures were still open — the reply is incomplete. */
  | { kind: 'truncated' };

/** Walks `source` from `start`, tracking bracket depth while ignoring brackets inside strings. */
function scanBalancedFrom(source: string, start: number): BalanceScan {
  const stack: string[] = [source[start] === '{' ? '}' : ']'];
  let inString = false;
  let escaping = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      stack.push('}');
      continue;
    }

    if (char === '[') {
      stack.push(']');
      continue;
    }

    if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return { kind: 'mismatch' };
      }
      if (stack.length === 0) {
        return { kind: 'balanced', candidate: source.slice(start, index + 1), end: index };
      }
    }
  }

  return { kind: 'truncated' };
}

/** Why a candidate yielded no usable document, for a caller-facing error message. */
export type JsonExtractionFailure = 'none' | 'truncated' | 'malformed';

type ExtractAttempt = {
  json: string | null;
  failure: JsonExtractionFailure;
};

function findFirstBalancedJson(text: string): ExtractAttempt {
  const source = text.trim();
  if (!source) return { json: null, failure: 'none' };

  let failure: JsonExtractionFailure = 'none';
  let start = 0;

  while (start < source.length) {
    const firstChar = source[start];
    if (firstChar !== '{' && firstChar !== '[') {
      start += 1;
      continue;
    }

    const scan = scanBalancedFrom(source, start);

    if (scan.kind === 'truncated') {
      // Everything past this point is nested inside the unterminated structure, so any
      // match would be a fragment of a document we never received in full.
      return { json: null, failure: 'truncated' };
    }

    if (scan.kind === 'mismatch') {
      // Not a JSON structure at all (stray brackets in prose); resume just after it.
      start += 1;
      continue;
    }

    const parsed = tryParseJsonCandidate(scan.candidate);
    if (parsed) {
      return { json: parsed, failure: 'none' };
    }

    // Balanced but invalid. Its children are almost certainly parseable, and returning
    // one of them would be a fragment — so skip the whole span rather than descend in.
    failure = 'malformed';
    start = scan.end + 1;
  }

  return { json: null, failure };
}

export function extractJSON(text: string): string {
  const candidates: string[] = [];
  const direct = text.trim();
  if (direct) {
    candidates.push(direct);
  }

  // A fenced block is the most likely place for the payload, so try it first. The lazy
  // match can stop early if the JSON itself contains a fence, which is exactly why the
  // unfenced text stays in the candidate list as a fallback.
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (jsonBlockMatch?.[1]?.trim()) {
    candidates.unshift(jsonBlockMatch[1].trim());
  }

  let failure: JsonExtractionFailure = 'none';

  for (const candidate of candidates) {
    const exact = tryParseJsonCandidate(candidate);
    if (exact) {
      return exact;
    }

    const balanced = findFirstBalancedJson(candidate);
    if (balanced.json) {
      return balanced.json;
    }
    if (balanced.failure !== 'none' && failure === 'none') {
      failure = balanced.failure;
    }
  }

  if (failure === 'truncated') {
    throw new Error('Model response ended mid-JSON; it was likely truncated by the provider output limit');
  }
  if (failure === 'malformed') {
    throw new Error('Model response contained a JSON document with a syntax error');
  }
  throw new Error('No valid JSON object found in model response');
}

/**
 * Extracts the reply's JSON and asserts it is a plain object.
 *
 * Every model call in this app expects a keyed payload. A bare array or scalar means the
 * model did not answer in the requested shape, and passing it through as an object would
 * produce a result that looks structurally fine but has lost most of its fields.
 */
export function extractJsonObject<T>(text: string, description: string): T {
  const parsed: unknown = JSON.parse(extractJSON(text));

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const actual = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : `a ${typeof parsed}`;
    throw new Error(`Expected ${description} to be a JSON object but the model returned ${actual}`);
  }

  return parsed as T;
}
