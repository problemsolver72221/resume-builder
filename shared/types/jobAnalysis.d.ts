/**
 * What the analyze-job-description call returns, after normalization.
 *
 * One analysis is paid for per posting and reused for every candidate in a batch, so this
 * shape is also what a saved batch run stores per row — see frontend batchState.
 */

export interface JobMeta {
  title: string;
  seniority: string;
  industry: string;
  department: string;
}

export interface JobSkills {
  required: string[];
  preferred: string[];
  tools: string[];
  technologies: string[];
}

export interface JobKeywords {
  actionVerbs: string[];
  buzzwords: string[];
  mustInclude: string[];
}

/** A term the posting spells out both ways, e.g. Infrastructure as Code / IaC. */
export interface AcronymPair {
  long: string;
  short: string;
}

export interface JobAnalysis {
  jobMeta: JobMeta;
  skills: JobSkills;
  responsibilities: string[];
  domainKnowledge: string[];
  softSkills: string[];
  keywords: JobKeywords;
  /**
   * Certifications and licenses the posting names. Optional because analyses stored before
   * the field existed have none; the normalizer fills it for new runs.
   */
  certifications?: string[];
  /**
   * Long/short pairs the posting itself spells out. The keyword-forms index merges them
   * with the registry so either spelling scores as one term.
   */
  acronyms?: AcronymPair[];
}
