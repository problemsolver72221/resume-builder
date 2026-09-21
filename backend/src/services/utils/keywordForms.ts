/**
 * Keyword forms: the spellings recruiters use for one and the same skill keyword.
 *
 * ATS scorers match strings, not meaning. A posting that asks for "Infrastructure as Code"
 * scores a resume that says "IaC" as a miss, and the other way round, so the skills section
 * renders acronym pairs as "Long (SHORT)" and every equality check in the pipeline treats
 * the forms of a group as one keyword. The registry lives in data/skills/keyword-forms.json
 * (see ../../database/keywordFormsDatabase.ts); this module is pure and takes the groups as
 * input so it can be tested without disk and so the tailoring pipeline can merge the
 * posting's own long/short pairs into the registry per build.
 *
 * Group shape: forms[0] is the primary spelling; for kind 'acronym' forms[1] is the acronym
 * used by pairedForm and forms[2..] are extra spellings that only affect equality; 'alias'
 * groups make forms equal and render whatever spelling was given. `display` overrides the
 * rendered pair. `families` restricts a group to those job-family ids (a group without it
 * applies everywhere): CMS means content management in marketing and something else on a
 * nurse's resume, so ambiguous acronyms ship scoped and the integrator filters with
 * groupsForFamily before indexing.
 */

export type KeywordFormKind = 'acronym' | 'alias';

export interface KeywordFormGroup {
  kind: KeywordFormKind;
  forms: string[];
  display?: string;
  families?: string[];
}

export interface KeywordFormIndex {
  /**
   * The groups that own at least one form, in the order they were given. A group whose
   * every form was claimed by a later group is dropped here.
   */
  readonly groups: readonly KeywordFormGroup[];
  /**
   * normalizeKeyword(form) to the group that owns it. When two groups carry the same
   * form the later one wins, so posting-spelled pairs appended after the registry take
   * precedence over the registry's wording; only the shipped file is asserted
   * collision-free.
   */
  readonly byForm: ReadonlyMap<string, KeywordFormGroup>;
}

const EMPTY_INDEX: KeywordFormIndex = { groups: [], byForm: new Map() };

/** Trim, collapse whitespace, lowercase. Every lookup and every key goes through this. */
export function normalizeKeyword(term: string): string {
  return typeof term === 'string' ? term.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function cleanForm(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Validates one raw group (from JSON on disk, or from code) and returns a clean copy, or
 * undefined when it cannot be used: unknown kind, no forms array, or fewer than two
 * distinct forms after normalization (one form has nothing to be equal to and nothing to
 * pair with). Extra keys are ignored so the data file can carry notes.
 */
export function sanitizeKeywordFormGroup(input: unknown): KeywordFormGroup | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const source = input as Record<string, unknown>;
  if (source.kind !== 'acronym' && source.kind !== 'alias') return undefined;
  if (!Array.isArray(source.forms)) return undefined;

  const seen = new Set<string>();
  const forms: string[] = [];
  for (const raw of source.forms) {
    const form = cleanForm(raw);
    const key = normalizeKeyword(form);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    forms.push(form);
  }
  if (forms.length < 2) return undefined;

  const group: KeywordFormGroup = { kind: source.kind, forms };
  const display = cleanForm(source.display);
  if (display) group.display = display;
  if (Array.isArray(source.families)) {
    const families = Array.from(new Set(source.families.map(cleanForm).filter(Boolean)));
    if (families.length > 0) group.families = families;
  }
  return group;
}

function lookupKeys(group: KeywordFormGroup): string[] {
  const keys = group.forms.map(normalizeKeyword);
  // The rendered pair itself must resolve to its group, or pairedForm(pairedForm(x)) would
  // wrap "Long (SHORT)" a second time when a display string is in play.
  if (group.display) keys.push(normalizeKeyword(group.display));
  return keys;
}

function claimForms(groups: readonly unknown[]): { groups: KeywordFormGroup[]; byForm: Map<string, KeywordFormGroup> } {
  const byForm = new Map<string, KeywordFormGroup>();
  const clean: KeywordFormGroup[] = [];
  for (const raw of groups) {
    const group = sanitizeKeywordFormGroup(raw);
    if (!group) continue;
    clean.push(group);
    for (const key of lookupKeys(group)) byForm.set(key, group);
  }
  const owning = new Set(byForm.values());
  return { groups: clean.filter((group) => owning.has(group)), byForm };
}

/**
 * Concatenates group lists (built-in file, then a deployment's data-dir file, then the
 * posting's pairs) under the index's last-wins-per-form rule and drops groups left with
 * no form, so an overlay extends the registry instead of forking it. Never throws.
 */
export function mergeKeywordFormGroups(...lists: ReadonlyArray<readonly KeywordFormGroup[]>): KeywordFormGroup[] {
  const all: KeywordFormGroup[] = [];
  for (const list of lists) {
    if (Array.isArray(list)) all.push(...list);
  }
  return claimForms(all).groups;
}

/** Builds the lookup index. Malformed groups are skipped; it never throws. */
export function indexKeywordForms(groups: readonly KeywordFormGroup[]): KeywordFormIndex {
  if (!Array.isArray(groups) || groups.length === 0) return EMPTY_INDEX;
  return claimForms(groups);
}

/** The groups that apply to one job family: unscoped groups plus those naming its id. */
export function groupsForFamily(groups: readonly KeywordFormGroup[], familyId: string): KeywordFormGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups.filter((group) => !group.families || group.families.length === 0 || group.families.includes(familyId));
}

/**
 * The group a term belongs to. The whole normalized string is looked up first; a trailing
 * parenthetical is only stripped when the term is a rendered pair, that is when the outer
 * and inner parts resolve to the same group. Applied unconditionally, "Python (Django)"
 * and "Kubernetes (EKS)" would be merged with the bare skill and pairedForm would rewrite
 * the posting's own parenthetical.
 */
function resolveGroup(term: string, index: KeywordFormIndex): KeywordFormGroup | undefined {
  const normalized = normalizeKeyword(term);
  if (!normalized) return undefined;
  const direct = index.byForm.get(normalized);
  if (direct) return direct;

  const match = /^(.+?)\s*\(([^()]+)\)$/.exec(normalized);
  if (!match) return undefined;
  const outer = index.byForm.get(match[1].trim());
  const inner = index.byForm.get(match[2].trim());
  return outer && outer === inner ? outer : undefined;
}

/** Canonical key: the group's primary form lower-cased, else normalizeKeyword(term). */
export function keywordKey(term: string, index: KeywordFormIndex): string {
  const group = resolveGroup(term, index);
  return group ? normalizeKeyword(group.forms[0]) : normalizeKeyword(term);
}

export function sameKeyword(a: string, b: string, index: KeywordFormIndex): boolean {
  return keywordKey(a, index) === keywordKey(b, index);
}

/**
 * Every spelling in the term's group in file order, primary form first, so
 * formsOf(term, index)[0] is the canonical display spelling of any term ("PostgreSQL" for
 * "psql", "React" for "reactjs"); an unknown term yields [term].
 */
export function formsOf(term: string, index: KeywordFormIndex): string[] {
  const group = resolveGroup(term, index);
  return group ? [...group.forms] : [term];
}

/**
 * Acronym group: "Long (SHORT)" (or the group's display). Alias group or unknown term:
 * unchanged. A term already written as "Long (SHORT)" resolves to its group and comes
 * back as the group's rendering, never wrapped twice.
 */
export function pairedForm(term: string, index: KeywordFormIndex): string {
  const group = resolveGroup(term, index);
  if (!group || group.kind !== 'acronym' || group.forms.length < 2) return term;
  return group.display ?? `${group.forms[0]} (${group.forms[1]})`;
}

/** Maps pairedForm over the terms and drops later duplicates by keywordKey, keeping first position. */
export function pairAcronyms(terms: readonly string[], index: KeywordFormIndex): string[] {
  const seen = new Set<string>();
  const paired: string[] = [];
  for (const term of terms) {
    const key = keywordKey(term, index);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paired.push(pairedForm(term, index));
  }
  return paired;
}

/** The groups any of the terms belong to, in index order, once each (for the prompt). */
export function relevantGroups(terms: readonly string[], index: KeywordFormIndex): KeywordFormGroup[] {
  const wanted = new Set<KeywordFormGroup>();
  for (const term of terms) {
    const group = resolveGroup(term, index);
    if (group) wanted.add(group);
  }
  return index.groups.filter((group) => wanted.has(group));
}

function cleanPairSide(value: unknown): string {
  // Models wrap the short side in the posting's own parentheses: "(IaC)". Only a fully
  // enclosed value is unwrapped; a long side ending in "(IaC)" is handled by the caller.
  let side = cleanForm(value);
  while (side.startsWith('(') && side.endsWith(')')) side = side.slice(1, -1).trim();
  return side;
}

/**
 * Acronym groups from the long/short pairs the posting itself spelled out, to append after
 * the registry: indexKeywordForms([...registry, ...groupsFromPairs(analysis.acronyms)]).
 * Model replies are sanitized so a bad one cannot poison the index: pairs with an empty
 * side, identical sides, or a short that is not shorter than the long (swapped sides) are
 * dropped, a long that already ends in "(SHORT)" loses that tail, and a short seen twice
 * keeps its first pair.
 */
export function groupsFromPairs(pairs: ReadonlyArray<{ long: string; short: string }> | null | undefined): KeywordFormGroup[] {
  if (!Array.isArray(pairs)) return [];
  const seen = new Set<string>();
  const groups: KeywordFormGroup[] = [];
  for (const pair of pairs) {
    if (typeof pair !== 'object' || pair === null) continue;
    const short = cleanPairSide((pair as { short?: unknown }).short);
    let long = cleanPairSide((pair as { long?: unknown }).long);
    const shortKey = normalizeKeyword(short);
    if (!shortKey || !long) continue;

    const tail = /^(.+?)\s*\(([^()]+)\)$/.exec(long);
    if (tail && normalizeKeyword(tail[2]) === shortKey) long = tail[1].trim();

    const longKey = normalizeKeyword(long);
    if (!longKey || longKey === shortKey || short.length >= long.length) continue;
    if (seen.has(shortKey)) continue;
    seen.add(shortKey);
    groups.push({ kind: 'acronym', forms: [long, short] });
  }
  return groups;
}
