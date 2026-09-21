import fs from 'fs/promises';
import path from 'path';
import { Profile } from '../types/profile';
import type { ResumeFormat } from '../types/template';
import { renderOutputPathTemplate, resolveStoredFilePath, sanitizePathSegment } from './outputStorage';
import { getOutputStorageSettings } from '../config/aiModelConfig';

function getCurrentDateFolder(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** A caller-supplied date segment, YYYY-MM-DD (underscores tolerated); anything else means "today". */
export function normalizeOutputDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^([0-9]{4})[-_]([0-9]{2})[-_]([0-9]{2})$/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

export interface GeneratedPathInfo {
  relativeBase: string;
  absoluteDir: string;
  storagePathBase: string;
  profileSlug: string;
  companyFolderName: string;
  roleSlug: string;
  profileFileSegment: string;
  companyFileSegment: string;
  roleFileSegment: string;
  /** The date segment the path was built with, YYYY-MM-DD. */
  outputDate: string;
}

export type GeneratedArtifactKind = 'resume' | 'coverletter';

const UPPERCASE_FILENAME_WORDS = new Set([
  'ai',
  'api',
  'aws',
  'ci',
  'cd',
  'crm',
  'css',
  'db',
  'devops',
  'etl',
  'gcp',
  'html',
  'http',
  'https',
  'ios',
  'it',
  'llm',
  'ml',
  'nlp',
  'qa',
  'rest',
  'saas',
  'sdk',
  'seo',
  'sre',
  'sql',
  'ui',
  'ux',
]);

function toTitleDashSegment(value: string, fallback: string): string {
  const words = (value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  const titleWords = words.map((word) => {
    const lower = word.toLowerCase();
    if (UPPERCASE_FILENAME_WORDS.has(lower)) {
      return lower.toUpperCase();
    }

    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  });

  return titleWords.join('-') || fallback;
}

export function buildGeneratedArtifactFilename(
  pathInfo: GeneratedPathInfo,
  kind: GeneratedArtifactKind,
  extension: 'pdf' | 'docx'
): string {
  const documentType = kind === 'coverletter' ? 'Cover-Letter' : 'Resume';
  return [
    pathInfo.profileFileSegment,
    documentType,
    pathInfo.roleFileSegment,
  ].join('-') + `.${extension}`;
}

export type GeneratedArtifactKey = 'resumePdf' | 'resumeDocx' | 'coverLetterPdf' | 'coverLetterDocx';

export interface GeneratedArtifactSpec {
  key: GeneratedArtifactKey;
  kind: GeneratedArtifactKind;
  extension: 'pdf' | 'docx';
}

export interface GenerationOutputOptions {
  format: ResumeFormat;
  coverLetter: boolean;
  coverLetterDocx: boolean;
}

/** The files one generation request writes, given its options — the definition of "done". */
export function listExpectedArtifacts(options: GenerationOutputOptions): GeneratedArtifactSpec[] {
  const specs: GeneratedArtifactSpec[] = [];
  if (options.format !== 'docx') specs.push({ key: 'resumePdf', kind: 'resume', extension: 'pdf' });
  if (options.format !== 'pdf') specs.push({ key: 'resumeDocx', kind: 'resume', extension: 'docx' });
  if (options.coverLetter) {
    specs.push({ key: 'coverLetterPdf', kind: 'coverletter', extension: 'pdf' });
    if (options.coverLetterDocx) specs.push({ key: 'coverLetterDocx', kind: 'coverletter', extension: 'docx' });
  }
  return specs;
}

export type ExistingArtifacts = Partial<Record<GeneratedArtifactKey, string>>;

/**
 * Storage-relative paths of every expected artifact when all of them are already on disk,
 * or null when any is missing. This is what lets a restarted batch resume instead of paying
 * to regenerate what it already has. All-or-nothing on purpose: a run that died between the
 * resume and its letter is redone whole so the pair stays consistent, and an empty file left
 * by an interrupted write does not count as finished.
 */
export async function findExistingArtifacts(
  pathInfo: GeneratedPathInfo,
  specs: readonly GeneratedArtifactSpec[]
): Promise<ExistingArtifacts | null> {
  if (specs.length === 0) return null;

  const found: ExistingArtifacts = {};
  for (const spec of specs) {
    const filename = buildGeneratedArtifactFilename(pathInfo, spec.kind, spec.extension);
    try {
      const stat = await fs.stat(path.join(pathInfo.absoluteDir, filename));
      if (!stat.isFile() || stat.size === 0) return null;
    } catch {
      return null;
    }
    found[spec.key] = `${pathInfo.storagePathBase}/${filename}`;
  }
  return found;
}

export async function getGeneratedOutputPath(
  profile: Profile,
  companyName: string,
  role: string,
  // A batch pins the date its first build used, so every build and every resume of that
  // batch lands in one folder even when the run crosses midnight or continues days later.
  options: { outputDate?: string } = {}
): Promise<GeneratedPathInfo> {
  const { outputBaseDir, outputPathTemplate } = await getOutputStorageSettings();
  const outputDate = options.outputDate ?? getCurrentDateFolder();
  const profileSlug = sanitizePathSegment(profile.name) || 'unknown';
  const companyFolderName = sanitizePathSegment(companyName || 'unknown') || 'unknown';
  const roleSlug = sanitizePathSegment(role || 'resume') || 'resume';
  const profileFileSegment = toTitleDashSegment(profile.name, 'Unknown');
  const companyFileSegment = toTitleDashSegment(companyName, 'Unknown');
  const roleFileSegment = toTitleDashSegment(role, 'Resume');
  const relativeBase = renderOutputPathTemplate(outputPathTemplate, {
    date: outputDate,
    profileName: profile.name || 'unknown',
    companyName: companyName || 'unknown',
    jobTitle: role || 'resume',
  });
  if (!outputBaseDir) {
    throw new Error('Output base directory is not configured.');
  }

  const absoluteDir = path.join(outputBaseDir, ...relativeBase.split('/'));
  const storagePathBase = relativeBase;

  return {
    relativeBase,
    absoluteDir,
    storagePathBase,
    profileSlug,
    companyFolderName,
    roleSlug,
    profileFileSegment,
    companyFileSegment,
    roleFileSegment,
    outputDate,
  };
}

export async function getGeneratedFilePath(relativePathValue: string): Promise<string | null> {
  const normalizedValue = relativePathValue.replace(/\\/g, '/').trim();
  if (!normalizedValue) {
    return null;
  }

  const { outputBaseDir } = await getOutputStorageSettings();
  const resolved = resolveStoredFilePath(outputBaseDir, normalizedValue);

  if (!resolved) {
    return null;
  }

  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return null;
  }
}
