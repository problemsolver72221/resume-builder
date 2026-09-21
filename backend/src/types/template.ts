/**
 * Template, job-analysis and tailored-content shapes.
 *
 * The parts both halves agree on live in shared/types and are re-exported here, so every
 * existing `from '../types/template'` import keeps working. What stays local is what the
 * frontend has no use for: the reply shapes the model answers in before normalization, and
 * the cover-letter style, which is typed against a runtime module this side owns.
 */
import type { CoverLetterStyle } from '../services/coverLetterVariation';
import type { JobAnalysis } from '@shared/types/jobAnalysis';
import type { TailoredContentBase, TailoredExperience } from '@shared/types/resume';

export type {
  AcronymPair,
  JobAnalysis,
  JobKeywords,
  JobMeta,
  JobSkills,
} from '@shared/types/jobAnalysis';

export type {
  ResumeFormat,
  SectionLabels,
  TailoredExperience,
  TailoredStrength,
} from '@shared/types/resume';

export type {
  CreateTemplateDTO,
  ManualTemplateConfigStored,
  ManualTemplateStyle,
  Template,
} from '@shared/types/template';

/**
 * The tailored resume as this side builds it: the shared shape plus the cover-letter
 * variation drawn for this call, which the PDF and DOCX renderers must both receive so the
 * two files for one application match.
 */
export interface TailoredContent extends TailoredContentBase {
  /** Visual style drawn with this letter; the PDF and DOCX must share it. */
  coverLetterStyle?: CoverLetterStyle;
  /** Seed behind this letter's brief and style, so a good one can be reproduced. */
  coverLetterSeed?: number;
}

/** A job analysis as the model returns it, before the normalizer coerces every field. */
export type RawNestedJobAnalysis = Partial<JobAnalysis> & {
  jobMeta?: {
    title?: unknown;
    seniority?: unknown;
    industry?: unknown;
    department?: unknown;
  };
  skills?: {
    required?: unknown;
    preferred?: unknown;
    tools?: unknown;
    technologies?: unknown;
  };
  responsibilities?: unknown;
  domainKnowledge?: unknown;
  softSkills?: unknown;
  keywords?: {
    actionVerbs?: unknown;
    buzzwords?: unknown;
    mustInclude?: unknown;
  };
  certifications?: unknown;
  acronyms?: unknown;
};

/**
 * One role as the model returns it. Only the written parts are asked for: the identity
 * fields are copied from the candidate profile by `index`, so the model cannot spend
 * output tokens retyping them — nor quietly alter a company name or a date.
 * The identity fields stay optional so a reply in the older shape still resolves.
 */
export type TailoredExperienceReply = Partial<TailoredExperience> & {
  /** 0-based position in the profile's `experience` array; 0 is the most recent role. */
  index?: number;
};

/** The tailored-resume reply before identity fields are merged back in from the profile. */
export type TailoredContentReply = Omit<Partial<TailoredContent>, 'experience'> & {
  experience?: TailoredExperienceReply[];
};

export interface GenerateResumeRequest {
  profileId: string;
  templateId: string;
  jobDescription?: string;
  jobAnalysis?: JobAnalysis;
  tailoredContent?: TailoredContent;
  /** A provider id, or "<providerId>/<model>" to run one of that provider's listed models. */
  model?: string;
  companyName: string;
  role: string;
  /**
   * Date segment for the output path (YYYY-MM-DD). A batch pins the date its first build
   * used so every build and every resume lands in one folder; defaults to today.
   */
  outputDate?: string;
  format?: import('@shared/types/resume').ResumeFormat;
  includeCoverLetterDocx?: boolean;
  /** Omit to fall back to the admin default. False skips the letter entirely — no AI call, no files. */
  includeCoverLetter?: boolean;
  /**
   * When true and every file this request would write already exists, answer with those
   * files and make no AI call. Lets an interrupted batch pick up where it stopped.
   */
  skipExisting?: boolean;
}
