/**
 * Resume headline from the posting title and the family's headline pattern.
 *
 * The old builder always produced "Senior {domain} Engineer", which turned a nursing
 * posting into "Senior Registered Engineer". Now every family carries a plain pattern
 * string ('{seniority} {title}', '{title}', ...) and this file only cleans the posting
 * title, resolves the placeholders and fills them; whether a family borrows seniority at
 * all is decided by whether its pattern mentions {seniority}, never by code here.
 */
import { GENERIC_ROLE_WORDS, seniorityForm } from './registry';
import type { JobFamilyContext, JobFamilyDefinition } from './types';

/**
 * Words that describe the posting rather than the role. Seen live in titles such as
 * "DevOps Engineer (Remote)", "Registered Nurse - Nights - Contract" and
 * "Remote - Senior DevOps Engineer"; a segment made only of these is dropped.
 */
const TITLE_NOTE_WORDS = new Set([
  'remote', 'hybrid', 'onsite', 'on-site', 'contract', 'contractor', 'full-time', 'fulltime',
  'part-time', 'parttime', 'temporary', 'temp', 'w2', 'c2c', 'freelance',
]);

/** "Engineer III", "Analyst II": the level belongs in the posting, not in a headline. */
const ROMAN_LEVEL = /^(i|ii|iii|iv)$/i;

/**
 * Segment separators: " - ", " – ", " — " (spaced, so "Front-End" survives), "|" and ",".
 * Parentheticals are removed before splitting so "(Remote, US)" cannot create segments.
 */
const SEGMENT_SEPARATOR = /\s+[-–—]\s+|[|,]/;

/** Kept lower-case inside a headline unless they come first: "Head of Sales". */
const SMALL_WORDS = new Set(['of', 'and', 'for', 'the', 'in', 'to', 'with', 'a', 'an']);

/**
 * Cleans a posting title down to the role it names.
 *
 * Rule: strip parentheses and brackets, split into segments, drop note words and roman
 * numerals from each segment, keep the first segment that is still non-empty. Trailing
 * segments are location, shift, contract or team notes far more often than part of the
 * role ("Registered Nurse (RN) - ICU - Nights", "Account Executive, Mid-Market",
 * "DevOps Engineer | Remote | Contract"), and a note-first title ("Remote - Senior DevOps
 * Engineer") still resolves because its first segment empties out. The price is that
 * "Manager, Data Platform" becomes "Manager"; a location detector or a growing list of
 * team-note words would cost more than that rare loss.
 */
function cleanPostingTitle(title: string): string {
  const withoutAsides = title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  for (const segment of withoutAsides.split(SEGMENT_SEPARATOR)) {
    const words = segment
      .split(/\s+/)
      .filter((word) => word && !TITLE_NOTE_WORDS.has(word.toLowerCase()) && !ROMAN_LEVEL.test(word));
    if (words.length > 0) return words.join(' ');
  }
  return '';
}

/** Title Case for one token, capitalising after hyphens and slashes too: "front-end" to "Front-End". */
function titleCaseToken(token: string): string {
  return token.toLowerCase().replace(/(^|[-/])([a-z])/g, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

/**
 * Casing: a token is kept as written when it is all caps or has an uppercase letter
 * after the first (DevOps, SRE, iOS, UI/UX, RN); otherwise it is Title Cased, with small
 * words lower-case unless first. A title with no lowercase letter at all and at least one
 * word of five letters or more ("SENIOR DEVOPS ENGINEER", common on job boards) is
 * shouting, so every token is Title Cased first; acronyms are lost in that case
 * ("Devops"), and a lowercase "devops engineer" comes out as "Devops Engineer" for the
 * same reason. Short all-caps titles such as "RN" or "QA Lead" keep their acronyms.
 * Seniority tokens are rendered through SENIORITY_FORMS so "Sr." becomes "Senior".
 */
function caseTitle(cleaned: string): string {
  const shouting = !/[a-z]/.test(cleaned) && /[A-Z]{5,}/.test(cleaned);
  const tokens = cleaned.split(' ').map((token) => (shouting ? titleCaseToken(token) : token));
  return tokens
    .map((token, index) => {
      const lower = token.toLowerCase();
      const seniority = seniorityForm(lower);
      if (seniority) return seniority;
      if (SMALL_WORDS.has(lower)) return index === 0 ? titleCaseToken(lower) : lower;
      const keepAsWritten = !/[a-z]/.test(token) || /[A-Z]/.test(token.slice(1));
      return keepAsWritten ? token : titleCaseToken(token);
    })
    .join(' ');
}

/** The rendered form of the first seniority word in `text`, or '' when there is none. */
function findSeniority(text: string | undefined): string {
  if (!text) return '';
  for (const word of text.toLowerCase().split(/[^a-z0-9.+#&]+/)) {
    const form = seniorityForm(word) ?? seniorityForm(word.replace(/\.+$/, ''));
    if (form) return form;
  }
  return '';
}

/** The cased title minus seniority, level and role words: "Senior DevOps Engineer" to "DevOps". */
function domainOf(casedTitle: string, family: JobFamilyDefinition): string {
  const roleWords = new Set([...GENERIC_ROLE_WORDS, ...(family.roleWords ?? []).map((word) => word.toLowerCase())]);
  return casedTitle
    .split(' ')
    .filter((token) => !roleWords.has(token.toLowerCase()))
    .join(' ');
}

/**
 * Fills the family's headline pattern. Placeholders: {title} is the cleaned, cased posting
 * title; {seniority} is the first seniority word in the posting title, else the profile's
 * own title, else the most recent experience title, and is left blank when the pattern
 * also prints {title} and that title already carries one (so "Senior Site Reliability
 * Engineer" is not doubled); {domain} is the title without role words. An empty or
 * note-only posting title returns the profile's own headline unchanged, because a
 * headline the posting did not supply must not be invented.
 */
export function buildHeadline(
  family: JobFamilyDefinition,
  context: JobFamilyContext,
  profile: { title?: string; experience?: ReadonlyArray<{ title?: string }> }
): string {
  const latestRole = profile.experience?.[0]?.title;
  const ownHeadline = profile.title?.trim() || latestRole?.trim() || '';
  const posted = String(context.title ?? '').trim();
  if (!posted) return ownHeadline;
  const cleaned = cleanPostingTitle(posted);
  if (!cleaned) return ownHeadline;

  const title = caseTitle(cleaned);
  const titleSeniority = findSeniority(title);
  const resolvedSeniority = titleSeniority || findSeniority(posted) || findSeniority(profile.title) || findSeniority(latestRole);
  const seniority = titleSeniority && family.headline.includes('{title}') ? '' : resolvedSeniority;

  const values: Record<string, string> = { title, seniority, domain: domainOf(title, family) };
  return family.headline
    .replace(/\{(\w+)\}/g, (_match, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''))
    .replace(/\s+/g, ' ')
    .trim();
}
