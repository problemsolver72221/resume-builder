import type { Profile } from '../../types/profile';
import { createRandom, shuffle } from '../../utils/seededRandom';

/** How many of a posting's hard-skill keywords the analysis keeps, most important first. */
export const HARD_SKILL_KEYWORD_CAP = 60;
/** Length of the hard-skills section on a resume. */
export const HARD_SKILL_TARGET = 45;
/** The soft-skills section is drawn to a length in this range. */
export const SOFT_SKILL_MIN = 12;
export const SOFT_SKILL_MAX = 15;

export interface HardSkillGroups {
  required: string[];
  preferred: string[];
  tools: string[];
  technologies: string[];
}

/** Identity of a skill for equality checks; the default is plain case-folding. */
export type SkillKey = (skill: string) => string;

const DEFAULT_SKILL_KEY: SkillKey = (skill) => skill.trim().toLowerCase();

/**
 * Trims the four skill groups to `cap` entries in total. The budget is spent on required
 * skills first, then technologies, tools and preferred ones, so the cut lands on the least
 * important end of the checklist; a skill listed in two groups counts once. `key` decides
 * what counts as the same skill: pass keywordKey from ./keywordForms so a posting that
 * lists "Kubernetes" and "K8s" spends one slot, not two.
 */
export function capHardSkillGroups(
  groups: HardSkillGroups,
  cap = HARD_SKILL_KEYWORD_CAP,
  key: SkillKey = (skill) => skill.toLowerCase()
): HardSkillGroups {
  const seen = new Set<string>();
  let budget = cap;
  const take = (items: string[]): string[] => {
    const kept: string[] = [];
    for (const item of items) {
      if (budget <= 0) break;
      const id = key(item);
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(item);
      budget -= 1;
    }
    return kept;
  };
  const required = take(groups.required);
  const technologies = take(groups.technologies);
  const tools = take(groups.tools);
  const preferred = take(groups.preferred);
  return { required, preferred, tools, technologies };
}

/** Everything a candidate wrote about themselves, for finding the skills they actually have. */
export function profileEvidenceText(profile: Profile): string {
  const parts: string[] = [profile.title, profile.summary, ...(profile.skills ?? [])];
  for (const role of profile.experience ?? []) {
    parts.push(role.title, role.description, ...(role.achievements ?? []));
  }
  for (const certification of profile.certifications ?? []) {
    parts.push(certification.name);
  }
  return parts.filter(Boolean).join('\n');
}

export interface SkillMixInput {
  /** The posting's hard-skill keywords, most important first. */
  jobHardSkills: readonly string[];
  /** The posting's must-have keywords, a subset of jobHardSkills; never sampled away. */
  mustHaveHardSkills?: readonly string[];
  /** Hard skills evidenced by the candidate's own profile; every one of them is kept. */
  profileHardSkills: readonly string[];
  jobSoftSkills: readonly string[];
  profileSoftSkills: readonly string[];
  /** Derived from candidate + job, so the same build always yields the same section. */
  seed: number;
  hardTarget?: number;
  /**
   * Identity used by every equality check in the mix. Defaults to case-folding; the
   * pipeline passes keywordKey from ./keywordForms so "IaC" in the profile and
   * "Infrastructure as Code" in the posting count as one evidenced skill.
   */
  key?: SkillKey;
}

export interface SkillMix {
  hardSkills: string[];
  softSkills: string[];
}

function dedupe(items: readonly string[], key: SkillKey): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function intersect(items: readonly string[], others: readonly string[], key: SkillKey): string[] {
  const keys = new Set(others.map(key));
  return items.filter((item) => keys.has(key(item)));
}

function without(items: readonly string[], excluded: readonly string[], key: SkillKey): string[] {
  const keys = new Set(excluded.map(key));
  return items.filter((item) => !keys.has(key(item)));
}

/**
 * Draws `count` items without replacement, each item's chance proportional to a weight
 * that falls with its position: the first weighs `items.length`, the last 1. (Efraimidis
 * and Spirakis: key = u^(1/w), keep the largest keys.) Earlier items are drawn often, later
 * ones seldom, so the draw is random and still follows the posting's priorities.
 */
function drawByPriority(random: () => number, items: readonly string[], count: number): string[] {
  if (count <= 0 || items.length === 0) return [];
  const keyed = items.map((item, index) => ({ item, key: Math.pow(random(), 1 / (items.length - index)) }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((entry) => entry.item);
}

/**
 * Composes one candidate's skills sections from the posting's keywords and the candidate's
 * own skills. The hard-skills section holds `hardTarget` items, in this order:
 *   1. the candidate's own skills that the posting also names, the strongest signal;
 *   2. the posting's remaining must-have keywords;
 *   3. every remaining skill the candidate's own profile evidences, so nothing of theirs is dropped;
 *   4. the open slots: half go to the next most important posting keywords outright, the
 *      other half are drawn at random from the rest, weighted by priority.
 * Groups 1 to 3 are shuffled with the seed and group 4 is drawn from it, so candidates
 * applying for the same posting show different lists while every list carries the
 * posting's must-haves and the candidate's own skills. Soft skills follow the same idea:
 * the ones the candidate evidences, then the candidate's own, then the posting's.
 */
export function mixSkillSections(input: SkillMixInput): SkillMix {
  const random = createRandom(input.seed);
  const hardTarget = input.hardTarget ?? HARD_SKILL_TARGET;
  const key = input.key ?? DEFAULT_SKILL_KEY;

  const job = dedupe(input.jobHardSkills, key);
  const own = dedupe(input.profileHardSkills, key);
  const mustHave = intersect(job, dedupe(input.mustHaveHardSkills ?? [], key), key);

  const evidenced = shuffle(random, intersect(job, own, key));
  const mustHaveRest = shuffle(random, without(mustHave, evidenced, key));
  const ownRest = shuffle(random, without(own, evidenced, key));
  const hardSkills = dedupe([...evidenced, ...mustHaveRest, ...ownRest], key).slice(0, hardTarget);

  const pool = without(job, hardSkills, key);
  const slots = hardTarget - hardSkills.length;
  const guaranteed = pool.slice(0, Math.ceil(slots / 2));
  const drawn = drawByPriority(random, pool.slice(guaranteed.length), slots - guaranteed.length);
  hardSkills.push(...guaranteed, ...drawn);

  const softTarget = SOFT_SKILL_MIN + Math.floor(random() * (SOFT_SKILL_MAX - SOFT_SKILL_MIN + 1));
  const jobSoft = dedupe(input.jobSoftSkills, key);
  const ownSoft = dedupe(input.profileSoftSkills, key);
  const evidencedSoft = shuffle(random, intersect(jobSoft, ownSoft, key));
  const softSkills = [
    ...evidencedSoft,
    ...shuffle(random, without(ownSoft, evidencedSoft, key)),
    ...shuffle(random, without(jobSoft, evidencedSoft, key)),
  ].slice(0, softTarget);

  return { hardSkills, softSkills };
}
