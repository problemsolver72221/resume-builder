import fs from 'fs/promises';
import path from 'path';
import {
  PromptCreateInput,
  PromptPreviewInput,
  PromptPreviewResult,
  PromptRecord,
  PromptResponseFormat,
  PromptSummary,
  PromptUpdateInput,
  PromptValidation,
  PromptVariableDefinition,
} from '../types/prompt';
import { isSafeId } from '../utils/safeId';
import type { PromptSegment } from '../providers/types';

const DATA_DIR = process.env.TAILOR_DATA_DIR
  ? path.resolve(process.env.TAILOR_DATA_DIR)
  : path.join(__dirname, '../../data');
const PROMPTS_DIR = path.join(DATA_DIR, 'prompts');
const CUSTOM_PROMPT_PREFIX = 'custom-';
const PROMPT_SUFFIX = '.json';
const VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;

type BuiltInPromptDefinition = {
  id: string;
  name: string;
  description: string;
  usage: string;
  responseFormat: PromptResponseFormat;
  allowedVariables: PromptVariableDefinition[];
};

type StoredCustomPromptMeta = {
  id: string;
  name: string;
  description: string;
  responseFormat: PromptResponseFormat;
  allowedVariables: PromptVariableDefinition[];
  createdAt: string;
  updatedAt: string;
};

type StoredPromptJson = Partial<StoredCustomPromptMeta> & {
  content?: unknown;
};

const BUILT_IN_PROMPTS: BuiltInPromptDefinition[] = [
  {
    id: 'analyze-job-description',
    name: 'Analyze Job Description',
    description: 'Extracts structured ATS keywords, role metadata, and soft-skill signals from a raw job description.',
    usage: 'Live prompt used by the resume analysis flow.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'jobDescription',
        description: 'Raw job description text pasted by the user.',
        sampleValue: `Senior Software Engineer

We are looking for a backend-focused engineer with strong Node.js, TypeScript, PostgreSQL, Docker, and AWS experience.

You will design scalable APIs, collaborate cross-functionally, improve reliability, and mentor teammates.

Preferred: GraphQL, Kubernetes, Terraform, CI/CD, and experience in fast-paced startup environments.`,
      },
    ],
  },
  {
    id: 'tailor-resume',
    name: 'Tailor Resume',
    description: 'Rewrites a profile against structured job analysis data and returns tailored resume content.',
    usage: 'Live prompt used when generating tailored resumes.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'profileJson',
        description: 'Serialized candidate profile JSON.',
        sampleValue: `{
  "name": "Jane Doe",
  "title": "Senior Software Engineer",
  "totalYearsExperience": 7,
  "summary": "Backend-focused engineer with experience in scalable systems.",
  "skills": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
  "experience": [
    {
      "title": "Senior Software Engineer",
      "company": "Acme",
      "startDate": "01/2022",
      "endDate": "Present",
      "location": "Remote",
      "description": "Builds backend services and platform tooling.",
      "achievements": [
        "Reduced API latency by 35%.",
        "Led migration to TypeScript."
      ]
    }
  ]
}`,
      },
      {
        name: 'jobAnalysisJson',
        description: 'Serialized job analysis JSON produced from the target job description.',
        sampleValue: `{
  "jobMeta": {
    "title": "Senior Backend Engineer",
    "seniority": "Senior",
    "industry": "Software",
    "department": "Engineering"
  },
  "skills": {
    "required": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
    "preferred": ["GraphQL", "Docker"],
    "tools": ["Docker"],
    "technologies": ["microservices", "CI/CD"]
  },
  "responsibilities": [
    "design and implement scalable backend services",
    "collaborate with product and design teams"
  ],
  "domainKnowledge": ["backend platforms", "distributed systems"],
  "softSkills": ["high ownership mentality", "excellent written communication"],
  "keywords": {
    "actionVerbs": ["design", "collaborate"],
    "buzzwords": ["scalable systems", "ownership mindset"],
    "mustInclude": ["Node.js", "TypeScript"]
  },
  "certifications": ["AWS Certified Solutions Architect"],
  "acronyms": [{ "long": "Continuous Integration", "short": "CI" }]
}`,
      },
      {
        name: 'jobTitle',
        description: 'Exact job title extracted from job analysis.',
        sampleValue: 'Senior Backend Engineer',
      },
      {
        name: 'hardSkillsJSON',
        description: 'Serialized combined hard skills array from required, preferred, technologies, and tools.',
        sampleValue: `["Node.js", "TypeScript", "PostgreSQL", "AWS", "GraphQL", "Docker"]`,
      },
      {
        name: 'domainKnowledge',
        description: 'Serialized domain knowledge and industry terms array.',
        sampleValue: `["backend platforms", "distributed systems", "Software"]`,
      },
      {
        name: 'keywordsJson',
        description: 'Serialized ATS keyword array.',
        sampleValue: `["scalable systems", "cross-functional collaboration", "ownership mindset"]`,
      },
      {
        name: 'keyResponsibilitiesJson',
        description: 'Serialized job responsibilities array.',
        sampleValue: `[
  "design and implement scalable backend services",
  "collaborate with product and design teams"
]`,
      },
      {
        name: 'softSkillsJSON',
        description: 'Serialized soft skills array.',
        sampleValue: `["high ownership mentality", "excellent written communication"]`,
      },
      {
        name: 'actionVerbPool',
        description: 'Past-tense verbs suited to this posting\'s job family, from the job-family registry.',
        sampleValue: 'Engineered, Architected, Deployed, Reduced, Accelerated, Automated, Consolidated, Refactored, Instrumented, Shipped, Scaled, Migrated',
      },
      {
        name: 'certificationsJson',
        description: 'Serialized array of certifications and licenses the posting names.',
        sampleValue: `["AWS Certified Solutions Architect", "CKA"]`,
      },
      {
        name: 'acronymPairsJson',
        description: 'Serialized array of long/short form pairs to write as "Long (SHORT)" at first mention.',
        sampleValue: `[{"long": "Infrastructure as Code", "short": "IaC"}, {"long": "Continuous Integration", "short": "CI"}]`,
      },
      {
        name: 'coverLetterRecipe',
        description: 'Per-letter brief (paragraph count, opening, rhythm, closing, register) drawn fresh for each generation so no two cover letters share a shape.',
        sampleValue: `Write the cover letter to this brief, which applies only to this letter:
- Exactly 3 paragraphs.
- Open mid-thought, as if continuing a conversation already underway.
- Keep every sentence under 20 words.
- Close on a concrete detail, not a summary.
- Register: dry and understated. Let the work speak; no enthusiasm words.`,
      },
    ],
  },
  {
    id: 'generate-cover-letter',
    name: 'Generate Cover Letter',
    description: 'Generates a concise cover letter body using the profile and application details.',
    usage: 'Live prompt used when there is no job description but a cover letter is requested.',
    responseFormat: 'text',
    allowedVariables: [
      {
        name: 'profileJson',
        description: 'Serialized candidate profile JSON.',
      },
      {
        name: 'companyName',
        description: 'Target company name.',
        sampleValue: 'Acme',
      },
      {
        name: 'role',
        description: 'Target role title.',
        sampleValue: 'Senior Software Engineer',
      },
    ],
  },
  {
    id: 'extract-template-from-pdf',
    name: 'Extract Template From PDF',
    description: 'Converts resume PDF text into an ATS-friendly Handlebars HTML template.',
    usage: 'Live prompt used when uploading a PDF to create a resume template.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'pdfText',
        description: 'Extracted text content from the uploaded PDF.',
        sampleValue: `JANE DOE
Senior Software Engineer
jane@example.com | San Francisco, CA | linkedin.com/in/jane

SUMMARY
Backend-focused engineer with experience building APIs and internal tooling.

EXPERIENCE
Senior Software Engineer | Acme | 2022 - Present
- Designed and shipped TypeScript APIs used by 5 internal teams.
- Improved reliability of background processing workloads.

EDUCATION
BS Computer Science | State University | 2018`,
      },
    ],
  },
  {
    id: 'extract-profile-from-resume',
    name: 'Extract Profile From Resume',
    description: 'Parses raw resume text into the structured profile schema used by the app.',
    usage: 'Live prompt used when importing resume text into a profile.',
    responseFormat: 'json',
    allowedVariables: [
      {
        name: 'resumeText',
        description: 'Full resume text extracted from an uploaded resume.',
        sampleValue: `JANE DOE
Senior Software Engineer
jane@example.com
San Francisco, CA

SUMMARY
Senior engineer focused on scalable backend systems.

EXPERIENCE
Senior Software Engineer, Acme, 01/2022 - Present
- Built Node.js services and improved system reliability.

SKILLS
Node.js, TypeScript, PostgreSQL, AWS`,
      },
    ],
  },
];

function isBuiltInPrompt(id: string): boolean {
  return BUILT_IN_PROMPTS.some((prompt) => prompt.id === id);
}

function getBuiltInPrompt(id: string): BuiltInPromptDefinition | undefined {
  return BUILT_IN_PROMPTS.find((prompt) => prompt.id === id);
}

function getPromptPath(id: string): string {
  if (!isSafeId(id)) {
    throw new Error(`Invalid prompt id "${id}"`);
  }
  return path.join(PROMPTS_DIR, `${id}${PROMPT_SUFFIX}`);
}

async function ensurePromptDirectory(): Promise<void> {
  await fs.mkdir(PROMPTS_DIR, { recursive: true });
}

function normalizePromptName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalizePromptDescription(description?: string): string {
  return description?.trim().replace(/\s+/g, ' ') ?? '';
}

function normalizePromptContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function normalizeResponseFormat(format?: PromptResponseFormat): PromptResponseFormat {
  return format === 'text' ? 'text' : 'json';
}

function normalizeVariableName(name: string): string {
  return name.trim();
}

function normalizeAllowedVariables(
  allowedVariables: PromptVariableDefinition[] | undefined
): PromptVariableDefinition[] {
  const seen = new Set<string>();
  const normalized: PromptVariableDefinition[] = [];

  for (const variable of allowedVariables ?? []) {
    const name = normalizeVariableName(variable?.name ?? '');
    if (!name) continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid variable name "${name}". Use letters, numbers, ".", "_" or "-".`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    normalized.push({
      name,
      description: variable.description?.trim() || undefined,
      sampleValue: variable.sampleValue,
    });
  }

  return normalized;
}

export function extractPromptVariables(content: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    const name = normalizeVariableName(match[1] ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }

  return found;
}

export function validatePromptContent(
  content: string,
  allowedVariables: PromptVariableDefinition[]
): PromptValidation {
  const usedVariables = extractPromptVariables(content);
  const allowed = new Set(allowedVariables.map((variable) => variable.name));
  const unknownVariables = usedVariables.filter((name) => !allowed.has(name));

  return {
    usedVariables,
    unknownVariables,
  };
}

function buildSampleValue(variableName: string): string {
  switch (variableName) {
    case 'jobDescription':
      return `Senior Software Engineer

Looking for a backend-leaning engineer with Node.js, TypeScript, PostgreSQL, Docker, AWS, and cross-functional collaboration experience.`;
    case 'profileJson':
      return `{
  "name": "Jane Doe",
  "title": "Senior Software Engineer",
  "totalYearsExperience": 7,
  "skills": ["Node.js", "TypeScript", "PostgreSQL", "AWS"]
}`;
    case 'jobAnalysisJson':
      return `{
  "jobMeta": {
    "title": "Senior Backend Engineer",
    "seniority": "Senior",
    "industry": "Software",
    "department": "Engineering"
  },
  "skills": {
    "required": ["Node.js", "TypeScript", "PostgreSQL", "AWS"],
    "preferred": ["GraphQL", "Docker"],
    "tools": ["Docker"],
    "technologies": ["microservices", "CI/CD"]
  },
  "responsibilities": ["design scalable backend services"],
  "domainKnowledge": ["backend platforms", "distributed systems"],
  "softSkills": ["ownership mindset"],
  "keywords": {
    "actionVerbs": ["design"],
    "buzzwords": ["scalable systems"],
    "mustInclude": ["Node.js", "TypeScript"]
  }
}`;
    case 'companyName':
      return 'Acme';
    case 'role':
      return 'Senior Software Engineer';
    case 'pdfText':
    case 'resumeText':
      return 'Sample resume text content for preview.';
    default:
      return `<sample:${variableName}>`;
  }
}

function buildSampleValues(
  allowedVariables: PromptVariableDefinition[],
  providedValues?: Record<string, string>
): Record<string, string> {
  const sampleValues: Record<string, string> = {};
  const provided = providedValues ?? {};

  for (const variable of allowedVariables) {
    sampleValues[variable.name] = provided[variable.name] ?? variable.sampleValue ?? buildSampleValue(variable.name);
  }

  return sampleValues;
}

function renderPromptText(
  content: string,
  sampleValues: Record<string, string>
): { renderedContent: string; missingVariables: string[] } {
  const missing = new Set<string>();
  const renderedContent = content.replace(VARIABLE_PATTERN, (_match, variableName: string) => {
    const name = normalizeVariableName(variableName);
    if (!(name in sampleValues)) {
      missing.add(name);
      return `[[${name}]]`;
    }
    return sampleValues[name] ?? '';
  });

  return {
    renderedContent,
    missingVariables: [...missing],
  };
}

function assertValidPromptDraft(
  content: string,
  allowedVariables: PromptVariableDefinition[]
): PromptValidation {
  const validation = validatePromptContent(content, allowedVariables);
  if (validation.unknownVariables.length > 0) {
    throw new Error(`Unknown prompt variables: ${validation.unknownVariables.join(', ')}`);
  }
  return validation;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'prompt';
}

async function generateCustomPromptId(name: string): Promise<string> {
  const base = `${CUSTOM_PROMPT_PREFIX}${slugify(name)}`;
  let candidate = base;
  let counter = 1;

  while (true) {
    try {
      await fs.access(getPromptPath(candidate));
      candidate = `${base}-${counter}`;
      counter += 1;
      continue;
    } catch {
      return candidate;
    }
  }
}

async function safeStat(filePath: string): Promise<{ createdAt: string; updatedAt: string } | null> {
  try {
    const stats = await fs.stat(filePath);
    return {
      createdAt: stats.birthtime.toISOString(),
      updatedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

async function readPromptJson(id: string): Promise<{
  parsed: StoredPromptJson;
  content: string;
  timestamps: { createdAt: string; updatedAt: string } | null;
} | null> {
  try {
    const filePath = getPromptPath(id);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredPromptJson;
    const content = normalizePromptContent(typeof parsed.content === 'string' ? parsed.content : '');
    if (!content) return null;

    return {
      parsed,
      content,
      timestamps: await safeStat(filePath),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readBuiltInPromptRecord(definition: BuiltInPromptDefinition): Promise<PromptRecord | null> {
  const stored = await readPromptJson(definition.id);
  if (!stored) {
    console.warn(`Built-in prompt file missing: ${definition.id}`);
    return null;
  }

  const validation = validatePromptContent(stored.content, definition.allowedVariables);

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    responseFormat: definition.responseFormat,
    allowedVariables: definition.allowedVariables,
    validation,
    isBuiltIn: true,
    usage: definition.usage,
    createdAt: typeof stored.parsed.createdAt === 'string'
      ? stored.parsed.createdAt
      : stored.timestamps?.createdAt ?? new Date().toISOString(),
    updatedAt: typeof stored.parsed.updatedAt === 'string'
      ? stored.parsed.updatedAt
      : stored.timestamps?.updatedAt ?? new Date().toISOString(),
    content: stored.content,
  };
}

async function readCustomPromptFile(id: string): Promise<(StoredCustomPromptMeta & { content: string }) | null> {
  const stored = await readPromptJson(id);
  if (!stored) return null;

  const parsed = stored.parsed;

  return {
    id: typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : id,
    name: normalizePromptName(typeof parsed.name === 'string' ? parsed.name : id),
    description: normalizePromptDescription(typeof parsed.description === 'string' ? parsed.description : ''),
    responseFormat: normalizeResponseFormat(parsed.responseFormat),
    allowedVariables: normalizeAllowedVariables(
      Array.isArray(parsed.allowedVariables) ? parsed.allowedVariables : []
    ),
    createdAt: typeof parsed.createdAt === 'string' && parsed.createdAt.trim()
      ? parsed.createdAt.trim()
      : stored.timestamps?.createdAt ?? new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
      ? parsed.updatedAt.trim()
      : stored.timestamps?.updatedAt ?? new Date().toISOString(),
    content: stored.content,
  };
}

async function writePromptJson(id: string, prompt: StoredPromptJson & { content: string }): Promise<void> {
  await fs.writeFile(getPromptPath(id), `${JSON.stringify(prompt, null, 2)}\n`, 'utf-8');
}

async function readCustomPromptRecord(id: string): Promise<PromptRecord | null> {
  const prompt = await readCustomPromptFile(id);
  if (!prompt) return null;

  return {
    id: prompt.id,
    name: prompt.name,
    description: prompt.description,
    responseFormat: prompt.responseFormat,
    allowedVariables: prompt.allowedVariables,
    validation: validatePromptContent(prompt.content, prompt.allowedVariables),
    isBuiltIn: false,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt,
    content: prompt.content,
  };
}

function toPromptSummary(record: PromptRecord): PromptSummary {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    responseFormat: record.responseFormat,
    allowedVariables: record.allowedVariables,
    validation: record.validation,
    isBuiltIn: record.isBuiltIn,
    usage: record.usage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function listPrompts(): Promise<PromptSummary[]> {
  await ensurePromptDirectory();

  const builtInRecords = (await Promise.all(BUILT_IN_PROMPTS.map(readBuiltInPromptRecord)))
    .filter((record): record is PromptRecord => record !== null);

  const entries = await fs.readdir(PROMPTS_DIR);
  const customIds = entries
    .filter((entry) => entry.endsWith(PROMPT_SUFFIX))
    .map((entry) => entry.slice(0, -PROMPT_SUFFIX.length))
    .filter((id) => isSafeId(id) && !isBuiltInPrompt(id));

  const customRecords = (await Promise.all(customIds.map(readCustomPromptRecord)))
    .filter((record): record is PromptRecord => record !== null)
    .sort((left, right) => left.name.localeCompare(right.name));

  return [...builtInRecords.map(toPromptSummary), ...customRecords.map(toPromptSummary)];
}

export async function getPromptById(id: string): Promise<PromptRecord | null> {
  await ensurePromptDirectory();

  if (isBuiltInPrompt(id)) {
    const definition = getBuiltInPrompt(id);
    if (!definition) return null;
    return readBuiltInPromptRecord(definition);
  }

  return readCustomPromptRecord(id);
}

export async function createPrompt(input: PromptCreateInput): Promise<PromptRecord> {
  await ensurePromptDirectory();

  const name = normalizePromptName(input.name);
  const description = normalizePromptDescription(input.description);
  const content = normalizePromptContent(input.content);
  const responseFormat = normalizeResponseFormat(input.responseFormat);
  const allowedVariables = normalizeAllowedVariables(input.allowedVariables);

  if (!name) {
    throw new Error('Prompt name is required');
  }
  if (!content) {
    throw new Error('Prompt content is required');
  }

  assertValidPromptDraft(content, allowedVariables);

  const id = await generateCustomPromptId(name);
  const now = new Date().toISOString();
  const prompt: StoredCustomPromptMeta & { content: string } = {
    id,
    name,
    description,
    responseFormat,
    allowedVariables,
    createdAt: now,
    updatedAt: now,
    content,
  };

  await writePromptJson(id, prompt);

  const saved = await getPromptById(id);
  if (!saved) {
    throw new Error('Failed to create prompt');
  }
  return saved;
}

export async function updatePrompt(id: string, input: PromptUpdateInput): Promise<PromptRecord | null> {
  await ensurePromptDirectory();

  const content = normalizePromptContent(input.content);
  if (!content) {
    throw new Error('Prompt content is required');
  }

  if (isBuiltInPrompt(id)) {
    const definition = getBuiltInPrompt(id);
    if (!definition) return null;

    assertValidPromptDraft(content, definition.allowedVariables);
    const existing = await readPromptJson(id);
    await writePromptJson(id, {
      id,
      content,
      createdAt: typeof existing?.parsed.createdAt === 'string'
        ? existing.parsed.createdAt
        : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return getPromptById(id);
  }

  const current = await readCustomPromptFile(id);
  if (!current) return null;

  const name = normalizePromptName(input.name ?? current.name);
  const description = normalizePromptDescription(input.description ?? current.description);
  const responseFormat = normalizeResponseFormat(input.responseFormat ?? current.responseFormat);
  const allowedVariables = normalizeAllowedVariables(input.allowedVariables ?? current.allowedVariables);

  if (!name) {
    throw new Error('Prompt name is required');
  }

  assertValidPromptDraft(content, allowedVariables);

  const nextPrompt: StoredCustomPromptMeta & { content: string } = {
    ...current,
    name,
    description,
    responseFormat,
    allowedVariables,
    updatedAt: new Date().toISOString(),
    content,
  };

  await writePromptJson(id, nextPrompt);

  return getPromptById(id);
}

export async function deletePrompt(id: string): Promise<boolean> {
  await ensurePromptDirectory();

  if (isBuiltInPrompt(id)) {
    throw new Error('Cannot delete built-in prompts');
  }

  const prompt = await getPromptById(id);
  if (!prompt) return false;

  await fs.unlink(getPromptPath(id)).catch(() => undefined);

  return true;
}

function resolveDraftSource(
  record: PromptRecord | null,
  input: PromptPreviewInput
): { content: string; allowedVariables: PromptVariableDefinition[] } {
  if (record) {
    return {
      content: input.content ? normalizePromptContent(input.content) : record.content,
      allowedVariables: record.isBuiltIn
        ? record.allowedVariables
        : normalizeAllowedVariables(input.allowedVariables ?? record.allowedVariables),
    };
  }

  const content = normalizePromptContent(input.content ?? '');
  const allowedVariables = normalizeAllowedVariables(input.allowedVariables);

  if (!content) {
    throw new Error('Prompt content is required');
  }

  return {
    content,
    allowedVariables,
  };
}

export async function previewPrompt(input: PromptPreviewInput): Promise<PromptPreviewResult> {
  await ensurePromptDirectory();

  const stored = input.id ? await getPromptById(input.id) : null;
  if (input.id && !stored) {
    throw new Error('Prompt not found');
  }

  const { content, allowedVariables } = resolveDraftSource(stored, input);
  const validation = validatePromptContent(content, allowedVariables);
  const sampleValues = buildSampleValues(allowedVariables, input.sampleValues);
  const { renderedContent } = renderPromptText(content, sampleValues);

  return {
    renderedContent,
    sampleValues,
    validation,
  };
}

export async function validatePromptDraft(input: PromptPreviewInput): Promise<PromptValidation> {
  await ensurePromptDirectory();

  const stored = input.id ? await getPromptById(input.id) : null;
  if (input.id && !stored) {
    throw new Error('Prompt not found');
  }

  const { content, allowedVariables } = resolveDraftSource(stored, input);
  return validatePromptContent(content, allowedVariables);
}

async function loadRenderablePrompt(id: string): Promise<PromptRecord> {
  const prompt = await getPromptById(id);
  if (!prompt) {
    throw new Error(`Prompt "${id}" not found`);
  }

  if (prompt.validation.unknownVariables.length > 0) {
    throw new Error(
      `Prompt "${id}" contains unknown variables: ${prompt.validation.unknownVariables.join(', ')}`
    );
  }

  return prompt;
}

function renderChunk(id: string, content: string, values: Record<string, string>): string {
  const { renderedContent, missingVariables } = renderPromptText(content, values);
  if (missingVariables.length > 0) {
    throw new Error(
      `Prompt "${id}" is missing runtime values for: ${missingVariables.join(', ')}`
    );
  }
  return renderedContent;
}

/** Index of the first `[[name]]` placeholder in `content`, or -1. */
function firstVariableIndex(content: string, name: string): number {
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    if (normalizeVariableName(match[1]) === name && typeof match.index === 'number') {
      return match.index;
    }
  }
  return -1;
}

export async function renderPrompt(
  id: string,
  values: Record<string, string>
): Promise<string> {
  const prompt = await loadRenderablePrompt(id);
  return renderChunk(id, prompt.content, values);
}

/**
 * Renders a prompt as ordered segments with cache boundaries.
 *
 * `tiers` names the variables from most stable to most volatile — for the tailoring
 * prompt, everything about the job first and the candidate profile last. A boundary is
 * placed just before each tier's earliest placeholder, so the text before it (all more
 * stable content) can be served from a provider's prompt cache: the rules are reused
 * across every call, and the job block across every profile in a batch.
 *
 * This only works when the template is written in that order. A tier whose variables
 * appear before a more stable tier's cannot be split off; it stays in the previous
 * chunk and a warning names the template so the ordering can be fixed.
 */
export async function renderPromptSegments(
  id: string,
  values: Record<string, string>,
  tiers: ReadonlyArray<ReadonlyArray<string>>
): Promise<PromptSegment[]> {
  const prompt = await loadRenderablePrompt(id);
  const content = prompt.content;

  const boundaries: number[] = [];
  let lastBoundary = 0;
  for (const tier of tiers) {
    const positions = tier.map((name) => firstVariableIndex(content, name)).filter((at) => at !== -1);
    if (positions.length === 0) continue;

    const at = Math.min(...positions);
    if (at <= lastBoundary) {
      console.warn(
        `Prompt "${id}": ${tier.join(', ')} cannot be cached separately because nothing more stable precedes it in the template.`
      );
      continue;
    }
    boundaries.push(at);
    lastBoundary = at;
  }

  const segments: PromptSegment[] = [];
  let start = 0;
  for (const at of boundaries) {
    segments.push({ text: renderChunk(id, content.slice(start, at), values), cache: true });
    start = at;
  }
  segments.push({ text: renderChunk(id, content.slice(start), values) });
  return segments;
}
