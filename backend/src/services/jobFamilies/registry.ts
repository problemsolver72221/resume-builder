/**
 * Job-family registry: one data entry per kind of role the builder tailors for.
 *
 * Before this existed every posting was treated as software engineering: the verb pool
 * offered to the model said "Engineered, Architected", the headline always came out as
 * "Senior X Engineer", and the keyword filter dropped "Registered Nurse" or "Incident
 * management" for not containing a web-stack word. Everything family-specific now lives
 * in JOB_FAMILIES; adding a family or a synonym is a data entry here, never a new branch.
 */
import type { JobFamilyContext, JobFamilyDefinition, JobFamilyMatch, SectionLabels } from './types';
import { DEFAULT_SECTION_LABELS } from './types';

/**
 * Seniority words as they appear in titles, mapped to the word the headline renders.
 * This is one map on purpose: a draft that kept a detection list and a level-word list
 * separately judged "Sr. DevOps Engineer" to carry no seniority and prepended the
 * profile's own "Senior", producing "Senior Sr. DevOps Engineer". The keys are the
 * detection list, the values the rendered form, and GENERIC_ROLE_WORDS is built from
 * the keys, so a new level word is added exactly once.
 */
export const SENIORITY_FORMS: Readonly<Record<string, string>> = {
  senior: 'Senior',
  sr: 'Senior',
  'sr.': 'Senior',
  junior: 'Junior',
  jr: 'Junior',
  'jr.': 'Junior',
  lead: 'Lead',
  principal: 'Principal',
  staff: 'Staff',
  associate: 'Associate',
  director: 'Director',
  head: 'Head',
  chief: 'Chief',
};

/** Safe lookup: a plain object would answer "constructor" with a function. */
export function seniorityForm(word: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(SENIORITY_FORMS, word) ? SENIORITY_FORMS[word] : undefined;
}

/**
 * Nouns that name a role, plus the discipline modifiers that only ever precede one
 * ("software" in "Software Engineer", "registered" in "Registered Nurse"). The modifiers
 * are generic rather than per family so that a data or generic posting listing
 * "Software Engineer" as a keyword still drops it from the skills chips, which is the
 * regression the old JOB_TITLE_EXCLUSIONS list guarded against.
 */
const ROLE_NOUNS: readonly string[] = [
  'engineer', 'developer', 'manager', 'analyst', 'specialist', 'consultant', 'architect',
  'administrator', 'coordinator', 'technician', 'representative', 'accountant', 'nurse',
  'designer', 'scientist', 'intern', 'assistant', 'officer', 'executive', 'supervisor',
  'vp', 'president', 'agent', 'clerk', 'strategist',
  // discipline modifiers
  'software', 'web', 'mobile', 'application', 'backend', 'back-end', 'frontend', 'front-end',
  'full-stack', 'fullstack', 'full', 'stack', 'registered', 'licensed', 'practical', 'vocational',
];

/** Level markers that appear in titles but are neither seniority nor role: "Engineer II", "Entry Level". */
const LEVEL_WORDS: readonly string[] = ['mid', 'mid-level', 'entry', 'entry-level', 'level', 'i', 'ii', 'iii', 'iv'];

export const GENERIC_ROLE_WORDS: readonly string[] = [...ROLE_NOUNS, ...LEVEL_WORDS, ...Object.keys(SENIORITY_FORMS)];

const GENERIC_ROLE_WORD_SET = new Set(GENERIC_ROLE_WORDS);

const labels = (hardSkills: string, overrides: Partial<SectionLabels> = {}): SectionLabels => ({
  ...DEFAULT_SECTION_LABELS,
  hardSkills,
  ...overrides,
});

const CORE_COMPETENCIES = { strengths: 'Core Competencies' } as const;
const LICENSED = { strengths: 'Core Competencies', certifications: 'Licenses & Certifications' } as const;

/**
 * Order matters twice: ties in resolveJobFamily go to the earlier entry, and the generic
 * family must stay last. devops-sre sits before software-engineering so that a "Software
 * Engineer - Infrastructure" posting gets the infrastructure verb pool; the families
 * with a bare discipline word in their titles ("operations", "medical", "marketing") sit
 * after the families whose compound titles contain that word.
 */
export const JOB_FAMILIES: readonly JobFamilyDefinition[] = [
  {
    id: 'devops-sre',
    label: 'DevOps / SRE',
    match: {
      titles: [
        'devops', 'dev ops', 'devsecops', 'sre', 'site reliability', 'reliability engineer',
        'platform engineer', 'platform engineering', 'infrastructure', 'cloud engineer',
        'cloud architect', 'cloud infrastructure', 'cloud operations', 'cloud security',
        'systems engineer', 'release engineer', 'build engineer', 'kubernetes',
        'security engineer', 'cybersecurity', 'information security', 'infosec',
      ],
      departments: ['platform engineering', 'site reliability', 'infrastructure', 'cloud operations', 'devops', 'sre', 'cloud'],
      industries: ['cloud computing', 'cloud infrastructure', 'cloud services', 'hosting'],
    },
    verbPool: [
      'Automated', 'Provisioned', 'Migrated', 'Containerized', 'Orchestrated', 'Hardened',
      'Instrumented', 'Scaled', 'Reduced', 'Eliminated', 'Standardized', 'Deployed', 'Upgraded',
      'Consolidated', 'Secured', 'Tuned', 'Remediated', 'Restored',
    ],
    sectionLabels: labels('Technical Skills'),
    headline: '{seniority} {title}',
    certificationEmphasis: 'high',
    roleWords: ['sre', 'devops', 'engineering'],
  },
  {
    id: 'software-engineering',
    label: 'Software Engineering',
    match: {
      titles: [
        'software engineer', 'software developer', 'software engineering', 'developer', 'swe',
        'backend', 'back-end', 'back end', 'frontend', 'front-end', 'front end',
        'full stack', 'full-stack', 'fullstack', 'web developer', 'mobile developer',
        'ios', 'android', 'application engineer', 'programmer', 'engineering manager',
        'software architect', 'solutions architect', 'technical architect', 'enterprise architect',
      ],
      departments: ['engineering', 'software', 'product engineering', 'software engineering', 'r&d', 'research and development'],
      industries: ['software', 'saas', 'information technology', 'technology'],
    },
    verbPool: [
      'Engineered', 'Architected', 'Built', 'Designed', 'Implemented', 'Refactored', 'Optimized',
      'Shipped', 'Integrated', 'Developed', 'Delivered', 'Scaled', 'Reduced', 'Automated',
      'Modernized', 'Debugged', 'Migrated', 'Launched',
    ],
    sectionLabels: labels('Technical Skills'),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['swe', 'engineering'],
  },
  {
    id: 'data',
    label: 'Data & Analytics',
    match: {
      titles: [
        'data engineer', 'data scientist', 'data analyst', 'data architect', 'data platform',
        'data infrastructure', 'data science', 'analytics engineer', 'analytics',
        'machine learning', 'machine learning engineer', 'ml engineer', 'ml', 'mlops',
        'ai engineer', 'ai', 'bi developer', 'bi', 'business intelligence', 'etl developer', 'etl',
        'database administrator', 'dba', 'data warehouse',
      ],
      departments: ['data', 'analytics', 'data science', 'data engineering', 'business intelligence', 'machine learning'],
      industries: ['analytics', 'data', 'artificial intelligence'],
    },
    verbPool: [
      'Analyzed', 'Modeled', 'Built', 'Designed', 'Automated', 'Engineered', 'Visualized',
      'Forecasted', 'Validated', 'Optimized', 'Migrated', 'Transformed', 'Aggregated', 'Cleaned',
      'Trained', 'Deployed', 'Quantified', 'Reported', 'Delivered',
    ],
    sectionLabels: labels('Technical Skills'),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['dba', 'engineering'],
  },
  {
    id: 'qa-testing',
    label: 'QA & Testing',
    match: {
      titles: [
        'qa', 'quality assurance', 'quality engineer', 'test engineer', 'sdet', 'test automation',
        'tester', 'software test', 'in test', 'engineer in test', 'software engineer in test',
      ],
      departments: ['quality assurance', 'qa', 'quality engineering', 'testing', 'quality'],
      industries: [],
    },
    verbPool: [
      'Tested', 'Automated', 'Verified', 'Validated', 'Detected', 'Reported', 'Reproduced',
      'Triaged', 'Documented', 'Designed', 'Executed', 'Reduced', 'Improved', 'Standardized',
      'Maintained', 'Prevented', 'Reviewed',
    ],
    sectionLabels: labels('Technical Skills'),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['qa', 'sdet', 'tester', 'test'],
  },
  {
    id: 'product-management',
    label: 'Product Management',
    match: {
      titles: [
        'product manager', 'product owner', 'product management', 'product lead', 'product operations',
        'group product manager', 'head of product', 'director of product', 'vp of product', 'vp product',
        'chief product officer', 'cpo',
      ],
      departments: ['product', 'product management'],
      industries: [],
    },
    verbPool: [
      'Launched', 'Defined', 'Prioritized', 'Shipped', 'Drove', 'Owned', 'Led', 'Researched',
      'Validated', 'Increased', 'Grew', 'Aligned', 'Delivered', 'Partnered', 'Analyzed',
      'Championed', 'Coordinated', 'Measured',
    ],
    sectionLabels: labels('Product Skills', CORE_COMPETENCIES),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['product', 'product owner', 'pm', 'cpo'],
  },
  {
    id: 'design',
    label: 'Design',
    match: {
      titles: [
        'ux', 'ui', 'ui/ux', 'ux/ui', 'product designer', 'ux designer', 'ui designer', 'visual designer',
        'graphic designer', 'interaction designer', 'ux researcher', 'design lead', 'designer',
        'creative director', 'art director', 'motion designer', 'brand designer', 'design systems',
      ],
      departments: ['design', 'ux', 'user experience', 'creative', 'product design'],
      industries: ['design', 'creative agency'],
    },
    verbPool: [
      'Designed', 'Prototyped', 'Researched', 'Redesigned', 'Iterated', 'Conducted', 'Created',
      'Delivered', 'Improved', 'Simplified', 'Established', 'Collaborated', 'Tested', 'Defined',
      'Crafted', 'Launched', 'Standardized',
    ],
    sectionLabels: labels('Design Skills', CORE_COMPETENCIES),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['ux', 'ui', 'ui/ux', 'ux/ui', 'researcher'],
  },
  {
    id: 'it-support',
    label: 'IT Support',
    match: {
      titles: [
        'it support', 'help desk', 'helpdesk', 'desktop support', 'service desk', 'technical support',
        'systems administrator', 'system administrator', 'sysadmin', 'network engineer',
        'network administrator', 'it technician', 'support technician', 'it specialist', 'it manager',
        'it analyst', 'field technician', 'information technology', 'security analyst', 'soc analyst',
        'it administrator', 'it operations',
      ],
      departments: ['it', 'information technology', 'it operations', 'technical support', 'help desk'],
      industries: ['managed services', 'it services'],
    },
    verbPool: [
      'Resolved', 'Troubleshot', 'Configured', 'Installed', 'Maintained', 'Supported', 'Deployed',
      'Administered', 'Documented', 'Upgraded', 'Monitored', 'Migrated', 'Secured', 'Reduced',
      'Trained', 'Managed', 'Restored', 'Imaged',
    ],
    sectionLabels: labels('Technical Skills'),
    headline: '{seniority} {title}',
    certificationEmphasis: 'high',
    roleWords: ['sysadmin', 'it', 'helpdesk', 'admin'],
  },
  {
    id: 'sales',
    label: 'Sales',
    match: {
      titles: [
        'sales', 'account executive', 'account manager', 'account director', 'business development',
        'sdr', 'bdr', 'sales representative', 'sales development', 'territory manager', 'sales engineer',
        'solutions engineer', 'inside sales', 'outside sales', 'regional sales', 'sales manager',
        'sales director', 'enterprise account', 'revenue', 'partnerships manager',
      ],
      departments: ['sales', 'business development', 'revenue', 'go-to-market', 'gtm'],
      industries: [],
    },
    verbPool: [
      'Closed', 'Prospected', 'Negotiated', 'Grew', 'Exceeded', 'Expanded', 'Retained', 'Generated',
      'Secured', 'Presented', 'Built', 'Managed', 'Achieved', 'Won', 'Qualified', 'Upsold',
      'Renewed', 'Forecasted',
    ],
    sectionLabels: labels('Sales Skills', CORE_COMPETENCIES),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['sdr', 'bdr', 'ae', 'sales', 'account'],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    match: {
      titles: [
        'marketing', 'seo', 'sem', 'content strategist', 'content marketing', 'brand manager', 'growth',
        'demand generation', 'social media', 'communications manager', 'copywriter', 'digital marketing',
        'marketing manager', 'product marketing', 'community manager', 'public relations', 'pr manager',
        'email marketing', 'performance marketing', 'paid media', 'marketer', 'content manager',
      ],
      departments: ['marketing', 'growth', 'communications', 'brand', 'demand generation'],
      industries: ['advertising', 'marketing agency', 'media'],
    },
    verbPool: [
      'Launched', 'Grew', 'Increased', 'Drove', 'Created', 'Optimized', 'Managed', 'Produced',
      'Developed', 'Positioned', 'Analyzed', 'Generated', 'Executed', 'Boosted', 'Published',
      'Segmented', 'Planned', 'Measured',
    ],
    sectionLabels: labels('Marketing Skills', CORE_COMPETENCIES),
    headline: '{seniority} {title}',
    certificationEmphasis: 'normal',
    roleWords: ['marketer', 'marketing', 'copywriter'],
  },
  {
    id: 'finance-accounting',
    label: 'Finance & Accounting',
    match: {
      titles: [
        'accountant', 'accounting', 'controller', 'bookkeeper', 'financial analyst', 'finance',
        'financial', 'fp&a', 'auditor', 'audit', 'tax', 'payroll', 'accounts payable',
        'accounts receivable', 'cfo', 'treasury', 'billing specialist', 'cpa', 'staff accountant',
        'finance manager',
      ],
      departments: ['finance', 'accounting', 'fp&a', 'treasury', 'tax', 'audit', 'payroll'],
      industries: ['accounting', 'banking', 'financial services', 'insurance', 'fintech'],
    },
    verbPool: [
      'Reconciled', 'Prepared', 'Audited', 'Forecasted', 'Analyzed', 'Reduced', 'Managed', 'Reported',
      'Closed', 'Reviewed', 'Streamlined', 'Budgeted', 'Processed', 'Identified', 'Implemented',
      'Ensured', 'Consolidated', 'Saved',
    ],
    sectionLabels: labels('Technical Skills', LICENSED),
    headline: '{seniority} {title}',
    certificationEmphasis: 'high',
    roleWords: ['cpa', 'controller', 'bookkeeper', 'auditor', 'accounting', 'finance', 'cfo'],
  },
  {
    id: 'healthcare',
    label: 'Healthcare',
    match: {
      titles: [
        'nurse', 'rn', 'registered nurse', 'lpn', 'lvn', 'cna', 'np', 'nurse practitioner', 'physician',
        'physician assistant', 'pa-c', 'medical assistant', 'medical', 'clinical', 'clinician',
        'therapist', 'physical therapist', 'occupational therapist', 'respiratory therapist',
        'pharmacist', 'pharmacy technician', 'phlebotomist', 'caregiver', 'patient care', 'radiology',
        'surgeon', 'dental', 'paramedic', 'emt', 'healthcare', 'health care', 'nursing', 'icu',
        'hospice', 'home health', 'medical technologist', 'veterinary', 'vet tech',
      ],
      departments: [
        'nursing', 'clinical', 'patient care', 'medical', 'emergency', 'icu', 'surgery', 'pharmacy',
        'radiology', 'health', 'clinical operations',
      ],
      industries: [
        'healthcare', 'health care', 'hospital', 'medical', 'clinic', 'nursing home', 'senior living',
        'health system', 'home health',
      ],
    },
    verbPool: [
      'Administered', 'Assessed', 'Monitored', 'Coordinated', 'Educated', 'Documented', 'Triaged',
      'Stabilized', 'Advocated', 'Collaborated', 'Implemented', 'Reduced', 'Provided', 'Managed',
      'Maintained', 'Evaluated', 'Delivered', 'Supported',
    ],
    sectionLabels: labels('Clinical Skills', LICENSED),
    headline: '{title}',
    certificationEmphasis: 'high',
    roleWords: [
      'rn', 'lpn', 'lvn', 'cna', 'np', 'pa-c', 'physician', 'therapist', 'practitioner', 'clinician',
      'surgeon', 'pharmacist', 'nursing', 'paramedic', 'emt', 'caregiver', 'phlebotomist',
    ],
  },
  {
    id: 'human-resources',
    label: 'Human Resources',
    match: {
      titles: [
        'human resources', 'hr', 'recruiter', 'recruiting', 'recruitment', 'talent acquisition',
        'people operations', 'people ops', 'people partner', 'hr business partner', 'hrbp', 'benefits',
        'compensation', 'talent', 'hr generalist', 'hr manager', 'sourcer', 'people & culture',
        'employee relations', 'learning and development', 'chief people officer',
      ],
      departments: ['human resources', 'hr', 'people', 'talent', 'recruiting', 'people operations'],
      industries: ['staffing', 'recruiting', 'human resources'],
    },
    verbPool: [
      'Recruited', 'Onboarded', 'Hired', 'Developed', 'Implemented', 'Managed', 'Administered',
      'Coached', 'Resolved', 'Reduced', 'Improved', 'Facilitated', 'Designed', 'Led', 'Negotiated',
      'Streamlined', 'Advised', 'Maintained',
    ],
    sectionLabels: labels('Professional Skills', CORE_COMPETENCIES),
    headline: '{title}',
    certificationEmphasis: 'normal',
    roleWords: ['recruiter', 'hr', 'hrbp', 'sourcer', 'generalist', 'hr business partner'],
  },
  {
    id: 'operations-project',
    label: 'Operations & Project Management',
    match: {
      titles: [
        'project manager', 'program manager', 'technical program manager', 'tpm', 'operations',
        'operations manager', 'scrum master', 'project coordinator', 'pmo', 'delivery manager',
        'supply chain', 'logistics', 'procurement', 'business operations', 'chief of staff',
        'agile coach', 'warehouse', 'production manager', 'office manager', 'facilities',
        'business analyst', 'planner', 'inventory', 'dispatcher', 'project management',
      ],
      departments: ['operations', 'pmo', 'program management', 'project management', 'supply chain', 'logistics', 'procurement'],
      industries: ['logistics', 'manufacturing', 'supply chain', 'transportation', 'warehousing', 'construction'],
    },
    verbPool: [
      'Delivered', 'Coordinated', 'Managed', 'Streamlined', 'Planned', 'Reduced', 'Improved', 'Led',
      'Implemented', 'Tracked', 'Scheduled', 'Negotiated', 'Standardized', 'Oversaw', 'Optimized',
      'Executed', 'Resolved', 'Launched',
    ],
    sectionLabels: labels('Professional Skills', CORE_COMPETENCIES),
    headline: '{seniority} {title}',
    certificationEmphasis: 'high',
    roleWords: ['pmo', 'tpm', 'scrum master', 'chief of staff', 'planner', 'dispatcher'],
  },
  {
    id: 'customer-success',
    label: 'Customer Success & Support',
    match: {
      titles: [
        'customer success', 'customer support', 'customer service', 'support specialist',
        'support engineer', 'technical account manager', 'onboarding specialist', 'client success',
        'implementation specialist', 'customer experience', 'csm', 'support representative',
        'call center', 'client services', 'customer care', 'customer success manager',
      ],
      departments: ['customer success', 'support', 'customer support', 'customer service', 'customer experience', 'client services'],
      industries: ['call center', 'bpo'],
    },
    verbPool: [
      'Resolved', 'Onboarded', 'Retained', 'Renewed', 'Supported', 'Reduced', 'Improved', 'Escalated',
      'Managed', 'Trained', 'Increased', 'Achieved', 'Built', 'Maintained', 'Advised', 'Documented',
      'Delivered', 'Exceeded',
    ],
    sectionLabels: labels('Professional Skills', CORE_COMPETENCIES),
    headline: '{title}',
    certificationEmphasis: 'normal',
    roleWords: ['csm', 'customer', 'success', 'client'],
  },
  {
    id: 'education',
    label: 'Education',
    match: {
      titles: [
        'teacher', 'instructor', 'professor', 'tutor', 'curriculum', 'instructional',
        'instructional designer', 'education', 'educator', 'lecturer', 'school principal', 'faculty',
        'teaching assistant', 'academic', 'trainer', 'corporate trainer', 'training specialist',
        'learning specialist', 'e-learning', 'elearning', 'paraprofessional', 'special education',
        'dean', 'admissions', 'enrollment',
      ],
      departments: ['education', 'academics', 'teaching', 'curriculum', 'learning', 'training', 'faculty', 'admissions'],
      industries: ['education', 'higher education', 'k-12', 'school', 'university', 'e-learning'],
    },
    verbPool: [
      'Taught', 'Designed', 'Developed', 'Delivered', 'Assessed', 'Mentored', 'Facilitated', 'Created',
      'Implemented', 'Improved', 'Guided', 'Planned', 'Evaluated', 'Coached', 'Led', 'Adapted',
      'Differentiated', 'Managed',
    ],
    sectionLabels: labels('Professional Skills', CORE_COMPETENCIES),
    headline: '{title}',
    certificationEmphasis: 'normal',
    roleWords: ['teacher', 'instructor', 'professor', 'tutor', 'educator', 'lecturer', 'faculty', 'dean', 'teaching', 'trainer'],
  },
  {
    id: 'legal',
    label: 'Legal',
    match: {
      titles: [
        'attorney', 'lawyer', 'paralegal', 'legal', 'counsel', 'compliance', 'contracts manager',
        'contract manager', 'litigation', 'law clerk', 'legal assistant', 'legal secretary', 'privacy',
        'regulatory affairs', 'general counsel', 'associate attorney',
      ],
      departments: ['legal', 'compliance', 'contracts', 'regulatory', 'privacy'],
      industries: ['law', 'legal services', 'law firm'],
    },
    verbPool: [
      'Drafted', 'Negotiated', 'Reviewed', 'Advised', 'Researched', 'Represented', 'Managed', 'Prepared',
      'Filed', 'Ensured', 'Resolved', 'Analyzed', 'Litigated', 'Counseled', 'Reduced', 'Implemented',
      'Coordinated', 'Monitored',
    ],
    sectionLabels: labels('Legal Skills', LICENSED),
    headline: '{title}',
    certificationEmphasis: 'high',
    roleWords: ['attorney', 'lawyer', 'paralegal', 'counsel', 'clerk', 'legal'],
  },
  {
    id: 'generic',
    label: 'General',
    match: { titles: [], departments: [], industries: [] },
    verbPool: [
      'Led', 'Managed', 'Delivered', 'Improved', 'Coordinated', 'Implemented', 'Developed', 'Built',
      'Streamlined', 'Increased', 'Reduced', 'Launched', 'Established', 'Organized', 'Achieved',
      'Supported', 'Trained', 'Resolved',
    ],
    sectionLabels: labels('Skills'),
    headline: '{title}',
    certificationEmphasis: 'normal',
  },
];

export const GENERIC_FAMILY: JobFamilyDefinition = JOB_FAMILIES[JOB_FAMILIES.length - 1];

export function getJobFamily(id: string): JobFamilyDefinition | undefined {
  return JOB_FAMILIES.find((family) => family.id === id);
}

/**
 * How much each match dimension is worth and which context field it reads. Scoring
 * iterates these maps, so a fourth dimension (keywords in the posting body, say) is a
 * field in JobFamilyMatch plus one entry in each map, not another code branch.
 */
const MATCH_WEIGHTS: Record<keyof JobFamilyMatch, number> = { titles: 3, departments: 2, industries: 1 };
const CONTEXT_FIELD: Record<keyof JobFamilyMatch, keyof JobFamilyContext> = {
  titles: 'title',
  departments: 'department',
  industries: 'industry',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const phrasePatterns = new Map<string, RegExp>();

/**
 * Whole-word, case-insensitive containment. The boundary is "not next to a letter or
 * digit" rather than \b because \b needs an adjacent word character, which phrases
 * like "c++", "c#", ".net" and "back-end" do not have at their edges; "sre" still does
 * not match "presre".
 */
export function matchesPhrase(text: string, phrase: string): boolean {
  let pattern = phrasePatterns.get(phrase);
  if (!pattern) {
    pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(phrase)}(?![A-Za-z0-9])`, 'i');
    phrasePatterns.set(phrase, pattern);
  }
  return pattern.test(text);
}

/** Sum of weights for every match phrase found in its context field. */
export function scoreJobFamily(family: JobFamilyDefinition, context: JobFamilyContext): number {
  let score = 0;
  for (const dimension of Object.keys(MATCH_WEIGHTS) as Array<keyof JobFamilyMatch>) {
    // jobMeta fields arrive from a model reply and can be missing despite the type.
    const text = String(context[CONTEXT_FIELD[dimension]] ?? '').trim();
    if (!text) continue;
    for (const phrase of family.match[dimension]) {
      if (matchesPhrase(text, phrase)) score += MATCH_WEIGHTS[dimension];
    }
  }
  return score;
}

/** Highest score wins; ties go to the earlier entry; nothing matched means the generic family. */
export function resolveJobFamily(context: JobFamilyContext): JobFamilyDefinition {
  let best = GENERIC_FAMILY;
  let bestScore = 0;
  for (const family of JOB_FAMILIES) {
    const score = scoreJobFamily(family, context);
    if (score > bestScore) {
      best = family;
      bestScore = score;
    }
  }
  return best;
}

/** Connectives inside a title that say nothing about whether it names a role: "Head of Sales". */
const TERM_STOP_WORDS = new Set(['of', 'and', 'the', 'for', 'in', 'a', 'an', '&']);

const familyRoleWordSets = new WeakMap<JobFamilyDefinition, Set<string>>();

function familyRoleWords(family: JobFamilyDefinition): Set<string> {
  let words = familyRoleWordSets.get(family);
  if (!words) {
    words = new Set((family.roleWords ?? []).map((word) => word.toLowerCase()));
    familyRoleWordSets.set(family, words);
  }
  return words;
}

/**
 * True when `term` names a role rather than a skill: every word (ignoring connectives) is
 * a generic or family role word, or the whole term is a phrase entry in family.roleWords
 * ("scrum master" is a role, while "Scrum" on its own is a methodology chip worth keeping).
 * "Software Engineer", "Senior Developer" and "RN" are roles; "Software architecture" and
 * "Backend development" are skills.
 */
export function isRoleTerm(term: string, family: JobFamilyDefinition): boolean {
  const normalized = term.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return false;
  const familyWords = familyRoleWords(family);
  if (familyWords.has(normalized)) return true;
  const words = normalized.split(' ').filter((word) => !TERM_STOP_WORDS.has(word));
  if (words.length === 0) return false;
  return words.every((word) => GENERIC_ROLE_WORD_SET.has(word) || familyWords.has(word));
}
