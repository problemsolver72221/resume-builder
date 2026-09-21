/**
 * Contracts shared by the job-family registry (./registry.ts), the tailoring pipeline and
 * the renderers. A job family is the kind of role a posting describes — software
 * engineering, nursing, sales — and everything that used to assume "software engineer"
 * (the verb pool offered to the model, the skills-section headings, the resume headline,
 * how much certifications matter) is looked up here per family instead. Adding a family
 * is one entry in JOB_FAMILIES; nothing else in the pipeline knows family names.
 */

// Declared in shared/types/resume.d.ts because the renderers and the frontend read it too;
// re-exported here so the registry and the pipeline keep importing it from one place.
export type { SectionLabels } from '@shared/types/resume';
import type { SectionLabels } from '@shared/types/resume';

/** Headings when nothing is known about the posting: untailored renders and older content. */
export const DEFAULT_SECTION_LABELS: SectionLabels = {
  hardSkills: 'Hard Skills',
  softSkills: 'Soft Skills',
  strengths: 'Strengths',
  certifications: 'Certifications',
};

export interface JobFamilyMatch {
  /** Phrases looked for in the posting's title, case-insensitive, whole words. Weight 3. */
  titles: readonly string[];
  /** Phrases looked for in jobMeta.department. Weight 2. */
  departments: readonly string[];
  /** Phrases looked for in jobMeta.industry. Weight 1. */
  industries: readonly string[];
}

export interface JobFamilyDefinition {
  id: string;
  label: string;
  match: JobFamilyMatch;
  /** Past-tense action verbs offered to the model as its preferred pool for bullets. */
  verbPool: readonly string[];
  sectionLabels: SectionLabels;
  /**
   * Resume headline pattern. Placeholders: {title} is the cleaned posting title;
   * {seniority} a seniority word taken from the posting title, else from the candidate's
   * own headline, and filled only when {title} carries none; {domain} the posting title
   * without seniority, level and role words. Double spaces are collapsed after filling.
   */
  headline: string;
  /** 'high' when certifications and licenses decide screening in this family. */
  certificationEmphasis: 'high' | 'normal';
  /** Words naming a role rather than a skill in this family, on top of GENERIC_ROLE_WORDS. */
  roleWords?: readonly string[];
}

/** What the registry needs from a job analysis to pick a family: the posting's jobMeta. */
export interface JobFamilyContext {
  title: string;
  department: string;
  industry: string;
}
