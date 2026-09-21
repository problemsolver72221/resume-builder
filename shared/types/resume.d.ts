/**
 * The tailored resume that one model call produces, and the shapes the renderers consume.
 */

/** Headings of the skills, strengths and certifications sections, chosen by the job family. */
export interface SectionLabels {
  hardSkills: string;
  softSkills: string;
  strengths: string;
  certifications: string;
}

export interface TailoredExperience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface TailoredStrength {
  title: string;
  description: string;
}

/**
 * Everything both halves agree on.
 *
 * The backend extends this with the cover-letter style and seed, which are typed against a
 * runtime module it owns and which the frontend never reads — see the note in shared/README.
 */
export interface TailoredContentBase {
  title: string;
  summary: string;
  experience: TailoredExperience[];
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  unconfirmedHardSkills: string[];
  unconfirmedSoftSkills: string[];
  /** Merged in from the job analysis; absent on older stored content. */
  requiredSkills?: string[];
  preferredSkills?: string[];
  strengths: TailoredStrength[];
  /** Body only — the greeting and sign-off are added by the letter renderer. */
  coverLetter?: string;
  /** Headings for this posting's family; renderers fall back to defaults without them. */
  sectionLabels?: SectionLabels;
  /** Id of the job family the tailoring ran under, for the UI and logs. */
  jobFamily?: string;
}

export type ResumeFormat = 'pdf' | 'docx' | 'both';
