import { Profile } from '../types/profile';
import type {
  JobAnalysis,
  RawNestedJobAnalysis,
  TailoredContent,
  TailoredContentReply,
  TailoredExperience,
  TailoredExperienceReply,
} from '../types/template';
import { renderPrompt, renderPromptSegments } from './promptService';
import { completeJson, completeText } from '../providers';
import { DEFAULT_PROVIDER_ID, type ModelTarget } from '../providers/registry';
import { readSkills } from '../database/skillsDatabase';
import { uniqueCaseInsensitive } from '../utils/array';
import { removeDuplicateSubstrings } from './utils/resumeBuilder';
import { mergeRoleIdentities, toRoleIdentity } from './utils/experienceMerge';
import { capHardSkillGroups, mixSkillSections, profileEvidenceText } from './utils/skillMix';
import { hashSeed } from '../utils/seededRandom';
import {
  clampRoleBrief,
  ensureMinLength,
  MIN_ROLE_BRIEF_LENGTH,
  TAILORED_ROLE_BRIEF_MAX_LENGTH,
} from './utils/roleBrief';
import { createCoverLetterVariation, OMIT_COVER_LETTER_RECIPE } from './coverLetterVariation';
import {
  buildHeadline,
  isRoleTerm,
  resolveJobFamily,
  type JobFamilyContext,
  type JobFamilyDefinition,
} from './jobFamilies';
import { readKeywordForms } from '../database/keywordFormsDatabase';
import {
  formsOf,
  groupsForFamily,
  groupsFromPairs,
  indexKeywordForms,
  keywordKey,
  pairAcronyms,
  relevantGroups,
  type KeywordFormIndex,
} from './utils/keywordForms';

/**
 * Cache tiers for the tailoring prompt, most stable first. Everything about the job is
 * identical for every candidate in a batch, so it is rendered ahead of the profile and a
 * caching provider reuses the rules for every call and the job block for every profile.
 */
const TAILOR_PROMPT_TIERS = [
  ['jobAnalysisJson', 'hardSkillsJSON', 'keywordsJson', 'keyResponsibilitiesJson', 'domainKnowledge', 'softSkillsJSON', 'jobTitle', 'actionVerbPool', 'certificationsJson', 'acronymPairsJson'],
  ['profileJson'],
] as const;

const technicalSkills = readSkills('hard');
const softSkills = readSkills('soft');

/**
 * Skill patterns, compiled once per database rather than once per call.
 *
 * The databases run to thousands of entries and every tailoring call scans three separate
 * texts, so building a fresh RegExp per skill per scan meant recompiling the whole database
 * several times for every resume. Cleared by refreshSkillCaches, so a skill confirmed
 * during a batch is still picked up by the next build in it.
 */
type CompiledSkill = { skill: string; pattern: RegExp };

let technicalSkillPatterns: CompiledSkill[] | null = null;
let softSkillPatterns: CompiledSkill[] | null = null;

function compileSkillPatterns(skills: readonly string[], caseSensitive: (skill: string) => boolean): CompiledSkill[] {
  return skills.map((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      skill,
      // "Go" only counts when spelled that way; lowercased it is an ordinary English verb.
      pattern: new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, caseSensitive(skill) ? '' : 'i'),
    };
  });
}

function getTechnicalSkillPatterns(): CompiledSkill[] {
  if (!technicalSkillPatterns) {
    technicalSkillPatterns = compileSkillPatterns(technicalSkills, (skill) => skill === 'Go');
  }
  return technicalSkillPatterns;
}

function getSoftSkillPatterns(): CompiledSkill[] {
  if (!softSkillPatterns) {
    softSkillPatterns = compileSkillPatterns(softSkills, () => false);
  }
  return softSkillPatterns;
}

export function refreshSkillCaches(): void {
  const nextTech = readSkills('hard');
  const nextSoft = readSkills('soft');

  technicalSkills.length = 0;
  technicalSkills.push(...nextTech);

  softSkills.length = 0;
  softSkills.push(...nextSoft);

  technicalSkillPatterns = null;
  softSkillPatterns = null;
}

function extractTechSkills(text: string): string[] {
  return getTechnicalSkillPatterns()
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.skill);
}

function extractSoftSkills(text: string): string[] {
  return getSoftSkillPatterns()
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.skill);
}

const SOFT_SKILL_SIGNALS = [
  'accountability',
  'communication',
  'collaboration',
  'mindset',
  'mentality',
  'ownership',
  'reliability',
  'resilient',
  'supportive',
  'eager to learn',
  'adaptability',
  'autonomy',
  'independent',
  'self-directed',
  'adapt',
  'ambiguity',
  'passion',
  'attention to detail',
  'team player',
  'cross-functional',
  'stakeholder',
  'leadership',
  'problem-solving',
  'product-minded',
  'driving clarity',
  'transparency',
];
const ATS_SOFT_SKILL_RULES: Array<{ canonical: string; patterns: string[] }> = [
  { canonical: 'Reliability', patterns: ['reliability', 'reliable'] },
  { canonical: 'Resilient', patterns: ['resilient', 'resilience'] },
  { canonical: 'Supportive', patterns: ['supportive', 'support'] },
  { canonical: 'Communication', patterns: ['communication', 'communicate'] },
  { canonical: 'Collaboration skills', patterns: ['collaboration', 'collaborative'] },
  { canonical: 'Cross-functional team', patterns: ['cross-functional', 'cross functional'] },
  { canonical: 'Strong problem-solving skills', patterns: ['problem-solving', 'problem solving'] },
  { canonical: 'Eager to learn', patterns: ['eager to learn', 'lifelong learning'] },
  { canonical: 'Accountability', patterns: ['accountability', 'accountable'] },
];
/**
 * The posting's job family plus the keyword spellings that apply to it. Resolved once per
 * analysis and threaded through tailoring: the family supplies the verb pool, the section
 * headings and the notion of what counts as a role rather than a skill, while the index
 * merges the shipped registry with any long/short pairs the posting spelled out itself.
 */
export interface JobContext {
  family: JobFamilyDefinition;
  keywords: KeywordFormIndex;
  /**
   * True when the skills database files the term as a soft skill and not also as a hard
   * one. The hard-skill section used to be kept clean by a list of technical markers a
   * term had to match; without it, a posting that lists "Teamwork" or "Critical thinking"
   * among its requirements would print them as clinical or technical skills.
   */
  isSoftOnly: (term: string) => boolean;
}

function familyContextOf(meta: JobAnalysis['jobMeta'] | undefined): JobFamilyContext {
  return {
    title: meta?.title ?? '',
    department: meta?.department ?? '',
    industry: meta?.industry ?? '',
  };
}

/**
 * @param acronyms Long/short pairs from the posting. They are appended after the registry
 *   so a posting that spells an acronym its own way wins any collision with the shipped one.
 */
export function resolveJobContext(
  meta: JobAnalysis['jobMeta'] | undefined,
  acronyms?: ReadonlyArray<{ long: string; short: string }>
): JobContext {
  const family = resolveJobFamily(familyContextOf(meta));
  // Snapshotted per analysis rather than once per process, so a skill confirmed during a
  // batch is honoured by the next build in that batch.
  const softNames = new Set(softSkills.map((skill) => skill.toLowerCase()));
  const hardNames = new Set(technicalSkills.map((skill) => skill.toLowerCase()));
  return {
    family,
    isSoftOnly: (term: string) => {
      const lower = term.trim().toLowerCase();
      return softNames.has(lower) && !hardNames.has(lower);
    },
    keywords: indexKeywordForms([
      ...groupsForFamily(readKeywordForms(), family.id),
      ...groupsFromPairs(acronyms),
    ]),
  };
}

/** The identity skillMix and the caps use, so "Kubernetes" and "K8s" are one skill. */
function skillKeyFor(context: JobContext): (skill: string) => string {
  return (skill: string) => keywordKey(skill, context.keywords);
}

function normalizeSkillsList(skills: string[] | undefined): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of skills) {
    if (typeof raw !== 'string') continue;
    const skill = raw.trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}


function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeJobAnalysisResponse(parsed: RawNestedJobAnalysis): JobAnalysis {
  const required = normalizeSkillsList(toStringList(parsed.skills?.required));
  const preferred = normalizeSkillsList(toStringList(parsed.skills?.preferred));
  const tools = normalizeSkillsList(toStringList(parsed.skills?.tools));
  const technologies = normalizeSkillsList(toStringList(parsed.skills?.technologies));
  const responsibilities = normalizeSkillsList(toStringList(parsed.responsibilities));
  const domainKnowledge = normalizeSkillsList(toStringList(parsed.domainKnowledge));
  const softSkills = prioritizeSoftSkills(normalizeSkillsList(toStringList(parsed.softSkills)));
  // Read only for its three known fields, each coerced by toStringList, so the raw
  // optional-unknown shape is all this needs — and unlike Record<string, unknown> it does
  // not ask the analysis type for an index signature it has no reason to carry.
  const keywordGroups: { actionVerbs?: unknown; buzzwords?: unknown; mustInclude?: unknown } =
    parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)
      ? parsed.keywords
      : {};
  const certifications = normalizeSkillsList(toStringList(parsed.certifications));
  // groupsFromPairs does the sanitizing (empty or swapped sides, duplicates); mapping the
  // groups back to pairs keeps only what the index would have accepted anyway.
  const acronyms = groupsFromPairs(parsed.acronyms as Array<{ long: string; short: string }> | undefined)
    .map((group) => ({ long: group.forms[0], short: group.forms[1] }));
  const jobMeta = {
    title: asString(parsed.jobMeta?.title),
    seniority: asString(parsed.jobMeta?.seniority),
    industry: asString(parsed.jobMeta?.industry),
    department: asString(parsed.jobMeta?.department),
  };
  // The 60-keyword cap is spent on distinct skills: without this key a posting naming both
  // "Kubernetes" and "K8s" burns two slots on one skill.
  const context = resolveJobContext(jobMeta, acronyms);

  return {
    jobMeta,
    skills: capHardSkillGroups({ required, preferred, tools, technologies }, undefined, skillKeyFor(context)),
    responsibilities,
    domainKnowledge,
    softSkills,
    keywords: {
      actionVerbs: normalizeSkillsList(toStringList(keywordGroups.actionVerbs)),
      buzzwords: normalizeSkillsList(toStringList(keywordGroups.buzzwords)),
      mustInclude: normalizeSkillsList([
        ...toStringList(keywordGroups.mustInclude),
      ]),
    },
    certifications,
    acronyms,
  };
}

function getJobAnalysisTitle(jobAnalysis?: JobAnalysis): string {
  return jobAnalysis?.jobMeta?.title?.trim() ?? '';
}

function getRequiredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.required);
}

function getPreferredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.preferred);
}

function getSkillTools(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.tools);
}

function getSkillTechnologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.technologies);
}

function getResponsibilities(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.responsibilities);
}

function getDomainKnowledge(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.domainKnowledge);
}

function getSoftSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.softSkills);
}

function getIndustryTerms(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    jobAnalysis?.jobMeta?.industry ?? '',
    jobAnalysis?.jobMeta?.department ?? '',
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

function getKeywordChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.keywords?.actionVerbs ?? []),
    ...(jobAnalysis?.keywords?.buzzwords ?? []),
    ...(jobAnalysis?.keywords?.mustInclude ?? []),
    ...getSkillTools(jobAnalysis),
    ...getSkillTechnologies(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

function getHardSkillChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getSkillTechnologies(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]);
}

function normalizeHardSkillAlias(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

function capitalizeHardSkill(s: string): string {
  if (!s || s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Longer than this and the "skill" is a sentence from the posting, not a section chip. */
const MAX_HARD_SKILL_WORDS = 6;

/**
 * The display spelling for a hard skill, or null when the term does not belong in the
 * section. What is rejected is family-neutral: a role rather than a skill ("Software
 * Engineer" for engineering, "Registered Nurse" for healthcare), a soft skill, or prose.
 * There is deliberately no list of technical markers to pass — that gate silently dropped
 * every skill outside software, so a nursing posting's "Medication administration" and a
 * finance posting's "Month-end close" never reached the resume.
 */
function resolveHardSkill(skill: string, context: JobContext): string | null {
  const normalized = skill.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 50 || /[.!?]/.test(normalized)) return null;
  if (normalized.split(' ').length > MAX_HARD_SKILL_WORDS) return null;

  const lower = normalizeHardSkillAlias(normalized);
  if (isRoleTerm(normalized, context.family)) return null;
  if (SOFT_SKILL_SIGNALS.some((signal) => lower.includes(signal))) return null;

  // The registry's primary form when it knows the term ("psql" to "PostgreSQL"), else the
  // posting's own wording with a leading capital.
  const canonical = formsOf(normalized, context.keywords)[0];
  if (context.isSoftOnly(normalized) || context.isSoftOnly(canonical)) return null;
  return canonical === normalized ? capitalizeHardSkill(normalized) : canonical;
}

function normalizeAllowedHardSkills(skills: string[], context: JobContext): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const key = skillKeyFor(context);

  for (const raw of skills) {
    const display = resolveHardSkill(raw, context);
    if (!display) continue;
    const id = key(display);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(display);
  }

  return result;
}

const MAX_SOFT_SKILL_LENGTH = 30;

/** Map long soft skill phrases to short key points */
const SOFT_SKILL_CONDENSE: Array<{ patterns: RegExp | string[]; key: string }> = [
  { patterns: ['excellent communication', 'communication and collaboration', 'communication skills', 'communicate'], key: 'Communication' },
  { patterns: ['collaboration', 'collaborative', 'collaborate'], key: 'Collaboration' },
  { patterns: ['cross-functional', 'cross functional'], key: 'Cross-functional' },
  { patterns: ['problem-solving', 'problem solving'], key: 'Problem-solving' },
  { patterns: ['ownership', 'high ownership'], key: 'Ownership' },
  { patterns: ['autonomy', 'self-directed', 'independent'], key: 'Autonomy' },
  { patterns: ['transparency', 'transparent'], key: 'Transparency' },
  { patterns: ['reliability', 'reliable'], key: 'Reliability' },
  { patterns: ['supportive', 'support'], key: 'Supportive' },
  { patterns: ['passionate', 'passion'], key: 'Passion' },
  { patterns: ['mentorship', 'mentor', 'help fellow'], key: 'Mentorship' },
  { patterns: ['adaptability', 'adapt'], key: 'Adaptability' },
  // A posting describes its own setting — "thrives in a fast-paced environment", "comfortable
  // with ambiguity" — and the resume should name the trait, not repeat the job ad.
  { patterns: ['fast-paced', 'fast paced', 'ambiguity', 'ambiguous', 'changing priorities'], key: 'Adaptability' },
  { patterns: ['eager to learn', 'lifelong learning'], key: 'Eager to learn' },
  { patterns: ['accountability', 'accountable'], key: 'Accountability' },
  { patterns: ['attention to detail', 'detail-oriented'], key: 'Attention to detail' },
  { patterns: ['team player', 'we are one team'], key: 'Team player' },
  { patterns: ['diverse', 'diversity'], key: 'Diversity' },
  { patterns: ['innovative', 'innovation', 'great ideas'], key: 'Innovation' },
  { patterns: ['analytics', 'applied ai'], key: 'Analytics & AI' },
  { patterns: ['scalable', 'polished'], key: 'Quality focus' },
];

/** Words a posting puts in front of a skill that say nothing about the skill itself. */
const SOFT_SKILL_INTENSIFIERS =
  /^(strong|excellent|good|great|proven|demonstrated|solid|exceptional|outstanding|effective|superior|deep|highly|very)\s+/i;

/**
 * The label printed on the resume. A posting writes "Excellent communication skills",
 * "Strong problem-solving skills" and "Comfortable in a fast-paced environment"; a resume
 * lists "Communication" and "Problem-solving". The condense table is consulted whatever the
 * phrase's length — it used to be skipped for anything under 30 characters, which is most
 * of what a posting actually writes, so the raw wording reached the page.
 */
function condenseSoftSkill(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  for (const { patterns, key } of SOFT_SKILL_CONDENSE) {
    const matches = Array.isArray(patterns)
      ? patterns.some((p) => lower.includes(p.toLowerCase()))
      : (patterns as RegExp).test(lower);
    if (matches) return key;
  }

  const stripped = trimmed.replace(SOFT_SKILL_INTENSIFIERS, '').replace(/\s+skills?$/i, '').trim();
  const base = stripped || trimmed;
  if (base.length <= MAX_SOFT_SKILL_LENGTH) {
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  const firstWord = base.split(/\s+/)[0];
  return firstWord ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1) : base;
}

/** Identity for the section: case, a trailing "skills" and a simple plural are the same skill. */
function softSkillKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+skills?$/, '').replace(/s$/, '');
}

/** Condenses each label and keeps the first of any that name the same skill. */
function dedupeSoftSkillLabels(skills: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of skills) {
    const label = condenseSoftSkill(raw);
    if (!label) continue;
    const key = softSkillKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(label);
  }
  return kept;
}

function prioritizeSoftSkills(skills: string[]): string[] {
  return [...skills].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aScore = SOFT_SKILL_SIGNALS.reduce((count, signal) =>
      count + (aLower.includes(signal) ? 1 : 0), 0);
    const bScore = SOFT_SKILL_SIGNALS.reduce((count, signal) =>
      count + (bLower.includes(signal) ? 1 : 0), 0);

    if (bScore !== aScore) return bScore - aScore;
    return a.length - b.length;
  });
}

function inferAtsSoftSkillsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return ATS_SOFT_SKILL_RULES
    .filter((rule) => rule.patterns.some((pattern) => lower.includes(pattern)))
    .map((rule) => rule.canonical);
}

function inferAtsSoftSkillsFromAnalysis(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];

  const text = [
    ...getSoftSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ].join(' | ');

  return inferAtsSoftSkillsFromText(text);
}

function prioritizeHardSkills(skills: string[], context: JobContext): string[] {
  // Keep normalized insertion order (no sorting).
  return normalizeAllowedHardSkills(skills, context);
}

function buildFallbackExperienceDescription(title: string, jobAnalysis?: JobAnalysis): string {
  const role = title.trim() || 'Engineer';
  const responsibility =
    getResponsibilities(jobAnalysis).find((item) => item.trim()) ||
    'delivering reliable solutions aligned with business goals';
  const keywords = getKeywordChecklist(jobAnalysis).slice(0, 2).join(', ');
  const suffix = keywords ? ` with focus on ${keywords}` : '';
  const text = `${role} focused on ${responsibility}${suffix}.`;
  return text.slice(0, TAILORED_ROLE_BRIEF_MAX_LENGTH).trim();
}

function buildFallbackAchievements(jobAnalysis?: JobAnalysis): string[] {
  const base = getResponsibilities(jobAnalysis)
    .filter((item) => item.trim())
    .slice(0, 3);

  if (base.length > 0) {
    return base.map((item) => item.replace(/\.$/, '').trim());
  }

  return [
    'Improved delivery consistency across critical projects.',
    'Enhanced service reliability and operational efficiency.',
  ];
}

function ensureSummaryUsesExperienceYears(summary: string, profile: Profile): string {
  const years = profile.totalYearsExperience;
  if (typeof years !== 'number' || !Number.isFinite(years) || years < 0) {
    return summary.trim();
  }

  const normalizedSummary = summary.trim().replace(/\s+/g, ' ');
  const yearsText = Number.isInteger(years) ? String(years) : years.toFixed(1);
  const prefixRole = profile.title?.trim() || 'Professional';
  const topSkills = (profile.skills ?? []).slice(0, 3);
  const skillsText = topSkills.length > 0 ? ` in ${topSkills.join(', ')}` : '';
  const leadSentence = `${prefixRole} with about ${yearsText} years of experience${skillsText}.`;

  // Keep the remaining summary content, but avoid duplicate years-style lead sentences.
  const remainder = normalizedSummary
    .replace(/^[^.]*\b\d+(?:\.\d+)?\s*\+?\s*years?\b[^.]*\.?\s*/i, '')
    .trim();

  return remainder ? `${leadSentence} ${remainder}` : leadSentence;
}

function limitSummaryNumericMentions(summary: string, maxMentions = 1): string {
  const text = summary.trim().replace(/\s+/g, ' ');
  if (!text) return text;

  const numberPattern = /\b\d+(?:\.\d+)?\+?\b/g;
  let seen = 0;

  return text.replace(numberPattern, (match) => {
    seen += 1;
    return seen <= maxMentions ? match : '';
  }).replace(/\s+/g, ' ').replace(/\s([.,;:!?])/g, '$1').trim();
}

function normalizeTailoredContent(
  content: TailoredContentReply,
  context: JobContext,
  jobAnalysis?: JobAnalysis,
  profile?: Profile
): TailoredContent {
  const MAX_SOFT_SKILLS = 15;

  // Job analysis skills FIRST (required, preferred, keywords) - must appear in hard skills
  const jobHardRaw = getHardSkillChecklist(jobAnalysis);
  const combinedHardRaw = [
    ...jobHardRaw,
    ...(content.requiredSkills ?? []),
    ...(content.preferredSkills ?? []),
    ...(content.hardSkills ?? content.skills ?? []),
    ...(profile?.skills ?? []),
  ];

  const atsSoftPriority = inferAtsSoftSkillsFromAnalysis(jobAnalysis);
  const hardSkills = prioritizeHardSkills(normalizeAllowedHardSkills(combinedHardRaw, context), context);
  const softFromModel = normalizeSkillsList(content.softSkills);
  const softFromAnalysis = getSoftSkills(jobAnalysis);
  const softMerged = normalizeSkillsList([...atsSoftPriority, ...softFromModel, ...softFromAnalysis]);
  const softSkills = prioritizeSoftSkills(softMerged);

  const hardLimited = hardSkills; // No limit on hard skills
  const softSlots = MAX_SOFT_SKILLS;
  const condensed = softSkills.slice(0, softSlots).map(condenseSoftSkill);
  const softSeen = new Set<string>();
  const softLimited = condensed.filter((s) => {
    const key = s.toLowerCase();
    if (softSeen.has(key)) return false;
    softSeen.add(key);
    return true;
  });

  const stripBoldTags = (s: string): string =>
    s.replace(/<\/?strong>/gi, '').replace(/<\/?b>/gi, '');

  /** Pads a thin brief from the posting, then clamps it; see services/utils/roleBrief. */
  const clampTailoredRoleBrief = (description: string): string =>
    clampRoleBrief(
      ensureMinLength(
        stripBoldTags(description).trim().replace(/\s+/g, ' '),
        MIN_ROLE_BRIEF_LENGTH,
        [
          ...getResponsibilities(jobAnalysis).slice(0, 3),
          ...getKeywordChecklist(jobAnalysis).slice(0, 2).map((k) => `Focus on ${k}.`),
        ]
      ),
      TAILORED_ROLE_BRIEF_MAX_LENGTH
    );

  const normalizeSummary = (summary: string): string =>
    stripBoldTags(summary).trim().replace(/\s+/g, ' ');

  // Built field by field rather than spread, so the reply's `index` — and anything else it
  // invented — stops here instead of travelling on into the templates.
  const normalizedExperience: TailoredExperience[] = mergeRoleIdentities(content.experience ?? [], profile).map(
    (item) => ({
      ...toRoleIdentity(item),
      description: clampTailoredRoleBrief(item.description ?? buildFallbackExperienceDescription(item.title ?? '', jobAnalysis)),
      achievements: normalizeSkillsList(item.achievements).length > 0
        ? normalizeSkillsList(item.achievements).map(stripBoldTags)
        : buildFallbackAchievements(jobAnalysis),
    })
  );

  const extractedJobTitle = getJobAnalysisTitle(jobAnalysis);
  if (normalizedExperience.length > 0 && extractedJobTitle) {
    const latestExperience = normalizedExperience[0];
    const baseDescription = (latestExperience.description ?? '').trim();
    const sentences = baseDescription
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const jobTitleSentence =
      `Aligned recent delivery with ${extractedJobTitle} role requirements and expected outcomes.`;
    const alreadyHasTitle = sentences.some((sentence) =>
      sentence.toLowerCase().includes(extractedJobTitle.toLowerCase())
    );
    if (!alreadyHasTitle) {
      const rewritten = sentences.length > 0
        ? [sentences[0], jobTitleSentence, ...sentences.slice(1)]
        : [jobTitleSentence];
      latestExperience.description = clampTailoredRoleBrief(rewritten.join(' '));
      normalizedExperience[0] = latestExperience;
    }
  }

  const strengthKeywordPool = normalizeSkillsList([
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]).filter((keyword) => keyword.length >= 3);

  const fallbackStrengths = getResponsibilities(jobAnalysis)
    .filter((item) => item.trim())
    .slice(0, 4)
    .map((item, index) => ({
      title: `Core Strength ${index + 1}`,
      description: item.trim().replace(/\.$/, '') + '.',
    }));

  const baseStrengths = (content.strengths ?? []).length > 0 ? (content.strengths ?? []) : fallbackStrengths;
  const normalizedStrengths = baseStrengths.map((strength, index) => {
    const title = (strength?.title ?? `Core Strength ${index + 1}`).trim() || `Core Strength ${index + 1}`;
    const rawDescription = (strength?.description ?? '').trim();
    const keywordA = strengthKeywordPool[index % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordB = strengthKeywordPool[(index + 7) % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordSnippet = [keywordA, keywordB]
      .filter(Boolean)
      .join(' and ');

    const normalizedDescription = rawDescription
      ? stripBoldTags(rawDescription).replace(/\s+/g, ' ').replace(/\.$/, '')
      : 'Demonstrated impact in demanding, fast-moving environments';

    const hasKeyword = strengthKeywordPool.some((kw) =>
      normalizedDescription.toLowerCase().includes(kw.toLowerCase())
    );
    const suffix = hasKeyword || !keywordSnippet
      ? '.'
      : `. Focused on ${keywordSnippet}.`;

    return {
      title,
      description: `${normalizedDescription}${suffix}`,
    };
  });

  return {
    ...content,
    title: buildHeadline(
      context.family,
      familyContextOf(jobAnalysis?.jobMeta ?? { title: content.title ?? '', seniority: '', industry: '', department: '' }),
      profile ?? {}
    ),
    jobFamily: context.family.id,
    sectionLabels: context.family.sectionLabels,
    summary: limitSummaryNumericMentions(
      normalizeSummary(
        profile ? ensureSummaryUsesExperienceYears(content.summary ?? '', profile) : (content.summary ?? '').trim()
      ),
      1
    ),
    experience: normalizedExperience,
    hardSkills: hardLimited,
    softSkills: softLimited,
    // tailorResume overwrites these from the confirmed lists; default them so a reply that
    // omitted them still produces a complete TailoredContent.
    unconfirmedHardSkills: content.unconfirmedHardSkills ?? [],
    unconfirmedSoftSkills: content.unconfirmedSoftSkills ?? [],
    strengths: normalizedStrengths,
    // Keep legacy field aligned with hard skills for older templates/components.
    skills: hardLimited,
  };
}

export async function analyzeJobDescription(jobDescription: string, target: ModelTarget = DEFAULT_PROVIDER_ID): Promise<JobAnalysis> {
  const prompt = await renderPromptSegments('analyze-job-description', {
    jobDescription,
  }, [['jobDescription']]);
  const parsed = await completeJson<RawNestedJobAnalysis>(
    target,
    { prompt, maxTokens: 7000, temperature: 0, responseFormat: 'json' },
    'the job analysis'
  );
  return normalizeJobAnalysisResponse(parsed);
}

/**
 * @param jobDescription The raw posting. Skill extraction runs against it directly, so it
 *   must belong to this request — a shared "last analysed" value leaked between resumes.
 */
export interface TailorResumeOptions {
  /**
   * Defaults to true. False drops the letter from the request as well as the result, so
   * the call stops paying for roughly 750 output tokens it would otherwise generate.
   */
  includeCoverLetter?: boolean;
}

export async function tailorResume(
  profile: Profile,
  jobAnalysis: JobAnalysis,
  jobDescription: string,
  target: ModelTarget = DEFAULT_PROVIDER_ID,
  options: TailorResumeOptions = {}
): Promise<TailoredContent> {
  const includeCoverLetter = options.includeCoverLetter ?? true;
  const context = resolveJobContext(jobAnalysis.jobMeta, jobAnalysis.acronyms);
  const keywords = getKeywordChecklist(jobAnalysis);
  const responsibilities = getResponsibilities(jobAnalysis);
  const keywordCount = keywords.length;
  const insertionTarget = keywordCount >= 2000 ? 2000 : keywordCount >= 1500 ? 1500 : keywordCount;
  // Drawn per call: the recipe lands in the prompt's volatile tail (after the cached
  // prefix, so caching is unaffected) and the style travels back for the PDF and DOCX.
  // With the letter switched off the same slot carries the override instead, which keeps
  // one template — and so one cache entry — for both modes.
  const variation = includeCoverLetter ? createCoverLetterVariation() : undefined;
  const prompt = await renderPromptSegments('tailor-resume', {
    coverLetterRecipe: variation?.recipe ?? OMIT_COVER_LETTER_RECIPE,
    profileJson: JSON.stringify(profile, null, 2),
    jobAnalysisJson: JSON.stringify(jobAnalysis, null, 2),
    jobTitle: getJobAnalysisTitle(jobAnalysis),
    hardSkillsJSON: JSON.stringify([...jobAnalysis.skills.preferred, ...jobAnalysis.skills.required, ...jobAnalysis.skills.technologies, ...jobAnalysis.skills.tools]),
    softSkillsJSON: JSON.stringify([...jobAnalysis.softSkills]),
    keywordsJson: JSON.stringify([...jobAnalysis.keywords.actionVerbs, ...jobAnalysis.keywords.buzzwords, ...jobAnalysis.keywords.mustInclude]),
    keyResponsibilitiesJson: JSON.stringify([...jobAnalysis.responsibilities]),
    domainKnowledge: JSON.stringify([...jobAnalysis.domainKnowledge, jobAnalysis.jobMeta.industry]),
    // The family's own verbs: "Diagnosed, Administered, Charted" for nursing rather than
    // the engineering verbs the prompt used to hard-code for every posting.
    actionVerbPool: context.family.verbPool.join(', '),
    certificationsJson: JSON.stringify(jobAnalysis.certifications ?? []),
    // Only the pairs this posting's own keywords touch, so the block stays short.
    acronymPairsJson: JSON.stringify(
      relevantGroups(getHardSkillChecklist(jobAnalysis), context.keywords)
        .filter((group) => group.kind === 'acronym' && group.forms.length >= 2)
        .map((group) => ({ long: group.forms[0], short: group.forms[1] }))
    ),
  }, TAILOR_PROMPT_TIERS);
  const parsed = await completeJson<TailoredContentReply>(
    target,
    // A generous wish; completeText clamps it to each provider's configured ceiling.
    { prompt, maxTokens: 32000, temperature: 0.2, responseFormat: 'json' },
    'the tailored resume'
  );

  const finalResult = normalizeTailoredContent(parsed, context, jobAnalysis, profile);

  // The skills section is composed here rather than copied from the model: the posting's
  // keywords mixed with the skills this candidate's own profile evidences, in an order
  // seeded by candidate + job. Nothing in the prompt differs between candidates, so the
  // cached job block is untouched, and no two candidates end up with the same list.
  const knownIn = (database: string[]) => {
    const known = new Set(database.map((skill) => skill.toLowerCase()));
    return (skill: string) => known.has(skill.toLowerCase());
  };
  const knownHard = knownIn(technicalSkills);
  const knownSoft = knownIn(softSkills);
  const evidence = profileEvidenceText(profile);
  const mix = mixSkillSections({
    jobHardSkills: normalizeAllowedHardSkills([
      ...jobAnalysis.skills.required,
      ...jobAnalysis.skills.technologies,
      ...jobAnalysis.skills.tools,
      ...jobAnalysis.skills.preferred,
    ], context),
    // Must-haves are never sampled away.
    mustHaveHardSkills: normalizeAllowedHardSkills([...jobAnalysis.skills.required], context),
    profileHardSkills: [
      ...extractTechSkills(evidence),
      ...normalizeAllowedHardSkills([...(parsed.hardSkills ?? []), ...(profile.skills ?? [])], context),
    ],
    jobSoftSkills: [
      ...extractSoftSkills(jobDescription),
      ...finalResult.softSkills,
      ...jobAnalysis.softSkills,
    ],
    profileSoftSkills: extractSoftSkills(evidence),
    seed: hashSeed(`${profile.id}|${jobDescription}`),
    // "IaC" in the profile and "Infrastructure as Code" in the posting are one evidenced skill.
    key: skillKeyFor(context),
  });

  finalResult.hardSkills = removeDuplicateSubstrings(mix.hardSkills);
  // The mix draws from the posting's own wording, so the labels are condensed here rather
  // than in normalizeTailoredContent, whose result this line used to overwrite: without it
  // a resume printed "Cross-functional team" and "Cross-functional teams" side by side.
  finalResult.softSkills = removeDuplicateSubstrings(dedupeSoftSkillLabels(mix.softSkills));
  // The posting's keywords go on the resume whether or not the skills database knows them:
  // they are the posting's own words, and filtering by the database used to leave a section
  // of seven where the posting named twenty. The ones the database does not know are listed
  // for review; confirming an item adds it to the database for later runs.
  finalResult.unconfirmedHardSkills = uniqueCaseInsensitive(finalResult.hardSkills.filter((skill) => !knownHard(skill)));
  finalResult.unconfirmedSoftSkills = uniqueCaseInsensitive(finalResult.softSkills.filter((skill) => !knownSoft(skill)));
  // Both spellings in one chip — "Infrastructure as Code (IaC)" — so a keyword scanner
  // matching either one scores the skill, whichever spelling the posting used.
  finalResult.hardSkills = pairAcronyms(finalResult.hardSkills, context.keywords);
  finalResult.skills = finalResult.hardSkills;

  if (variation) {
    finalResult.coverLetterStyle = variation.style;
    finalResult.coverLetterSeed = variation.seed;
  } else {
    // Belt and braces: if the model wrote a letter anyway, drop it here so no caller can
    // render one that was switched off.
    delete finalResult.coverLetter;
    delete finalResult.coverLetterStyle;
    delete finalResult.coverLetterSeed;
  }

  return finalResult;
}

/**
 * Generate a cover letter body when no job description is provided.
 * Returns only the body text (no salutation or sign-off).
 */
export async function generateCoverLetter(
  profile: Profile,
  companyName: string,
  role: string,
  target: ModelTarget = DEFAULT_PROVIDER_ID
): Promise<string> {
  const prompt = await renderPrompt('generate-cover-letter', {
    profileJson: JSON.stringify(profile, null, 2),
    companyName,
    role,
  });
  const content = await completeText(target, { prompt, maxTokens: 1500, temperature: 0.7, responseFormat: 'text' });
  return content.trim();
}

export async function extractTemplateFromPDF(
  pdfText: string,
  templateName: string,
  target: ModelTarget = DEFAULT_PROVIDER_ID
): Promise<{ html: string; css: string; sections: string[] }> {
  const prompt = await renderPrompt('extract-template-from-pdf', { pdfText, templateName });
  return completeJson<{ html: string; css: string; sections: string[] }>(
    target,
    { prompt, maxTokens: 8000, temperature: 0, responseFormat: 'json' },
    'the extracted template'
  );
}

export async function extractProfileFromResume(
  resumeText: string,
  target: ModelTarget = DEFAULT_PROVIDER_ID
): Promise<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> {
  const prompt = await renderPrompt('extract-profile-from-resume', { resumeText });
  return completeJson<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>>(
    target,
    { prompt, maxTokens: 4000, temperature: 0, responseFormat: 'json' },
    'the extracted profile'
  );
}

