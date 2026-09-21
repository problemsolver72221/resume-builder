import fs from 'fs';
import path from 'path';
import { mergeKeywordFormGroups, sanitizeKeywordFormGroup } from '../services/utils/keywordForms';
import type { KeywordFormGroup } from '../services/utils/keywordForms';

export type { KeywordFormGroup, KeywordFormKind } from '../services/utils/keywordForms';

/**
 * Where the keyword-forms registry (equivalent spellings and acronym pairs, see
 * ../services/utils/keywordForms.ts) is read from.
 *
 * The built-in file next to the source is always loaded; a deployment's copy under
 * TAILOR_DATA_DIR/skills is an overlay on top of it, not a replacement, so three extra
 * pairs in a data dir do not require copying the whole list and never block upstream
 * additions. Unlike skillsDatabase this never creates the data-dir file: an empty file
 * written there would shadow nothing but still be a second registry to maintain.
 */

const DATA_DIR = process.env.TAILOR_DATA_DIR
  ? path.resolve(process.env.TAILOR_DATA_DIR)
  : path.join(__dirname, '../../data');
const KEYWORD_FORMS_FILE = path.join(DATA_DIR, 'skills', 'keyword-forms.json');
// Resolved from the compiled module's location (dist/database), not from cwd, so the
// registry is found wherever the server is started from.
const BUILT_IN_KEYWORD_FORMS_FILE = path.join(__dirname, '../../data/skills/keyword-forms.json');

let cache: KeywordFormGroup[] | undefined;

/** The two files consulted, for diagnostics and tests; compare with path.normalize. */
export function getKeywordFormsPaths(): { dataFile: string; builtIn: string } {
  return { dataFile: KEYWORD_FORMS_FILE, builtIn: BUILT_IN_KEYWORD_FORMS_FILE };
}

/**
 * Groups of one file, or undefined when it is absent, unreadable, not JSON, or has no
 * `groups` array. Malformed entries inside a valid file are skipped, never fatal, so one
 * bad line in a data-dir overlay does not empty the registry.
 */
function readGroupsFile(file: string): KeywordFormGroup[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return undefined;

  const valid: KeywordFormGroup[] = [];
  for (const entry of groups) {
    const group = sanitizeKeywordFormGroup(entry);
    if (group) valid.push(group);
  }
  return valid;
}

function loadKeywordForms(): KeywordFormGroup[] {
  const builtIn = readGroupsFile(BUILT_IN_KEYWORD_FORMS_FILE) ?? [];
  if (path.normalize(KEYWORD_FORMS_FILE) === path.normalize(BUILT_IN_KEYWORD_FORMS_FILE)) {
    return mergeKeywordFormGroups(builtIn);
  }
  const overlay = readGroupsFile(KEYWORD_FORMS_FILE) ?? [];
  return mergeKeywordFormGroups(builtIn, overlay);
}

/**
 * The registry: built-in groups with the data-dir overlay applied (a form in both belongs
 * to the overlay's group). Cached after the first read; treat the result as read-only and
 * call refreshKeywordForms() after editing a file.
 */
export function readKeywordForms(): KeywordFormGroup[] {
  if (!cache) cache = loadKeywordForms();
  return cache;
}

/** Drops the cache and re-reads both files. */
export function refreshKeywordForms(): KeywordFormGroup[] {
  cache = undefined;
  return readKeywordForms();
}
