import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_GENERATED_RESUMES_DIR = path.join(__dirname, '..', '..', '..', 'generated');
export const DEFAULT_OUTPUT_PATH_TEMPLATE = '/{{profile name}}/{{date}}/{{company name}}/{{job title}}';

export const OUTPUT_PATH_TOKENS = [
  { token: '{{date}}', description: 'Current date as YYYY-MM-DD' },
  { token: '{{profile name}}', description: 'Selected profile name' },
  { token: '{{company name}}', description: 'Company name' },
  { token: '{{job title}}', description: 'Role / job title' },
] as const;

type OutputPathVariables = {
  date: string;
  profileName: string;
  companyName: string;
  jobTitle: string;
};

const OUTPUT_TOKEN_ALIASES: Record<string, keyof OutputPathVariables> = {
  date: 'date',
  profile: 'profileName',
  'profile name': 'profileName',
  company: 'companyName',
  'company name': 'companyName',
  role: 'jobTitle',
  'job title': 'jobTitle',
};

export function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function expandUserPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function normalizeOutputBaseDir(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim()
    ? expandUserPath(value.trim())
    : DEFAULT_GENERATED_RESUMES_DIR;
  return path.resolve(candidate);
}

export function validateOutputBaseDir(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Output base directory is required');
  }

  const normalized = normalizeOutputBaseDir(value);
  if (!path.isAbsolute(normalized)) {
    throw new Error('Output base directory must be an absolute path');
  }

  return normalized;
}

export async function ensureWritableOutputDir(value: string): Promise<string> {
  const normalized = validateOutputBaseDir(value);
  await fs.mkdir(normalized, { recursive: true });
  await fs.access(normalized, fsConstants.W_OK);
  return normalized;
}

export function normalizeOutputPathTemplate(value: unknown): string {
  const trimmed = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_OUTPUT_PATH_TEMPLATE;
  const withForwardSlashes = trimmed.replace(/\\/g, '/');
  const withLeadingSlash = withForwardSlashes.startsWith('/')
    ? withForwardSlashes
    : `/${withForwardSlashes}`;
  const compact = withLeadingSlash.replace(/\/{2,}/g, '/');
  if (compact.length > 1 && compact.endsWith('/')) {
    return compact.slice(0, -1);
  }
  return compact;
}

export function validateOutputPathTemplate(value: unknown): string {
  const normalized = normalizeOutputPathTemplate(value);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('Output path template must contain at least one folder segment');
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('Output path template cannot contain "." or ".." segments');
    }

    for (const match of segment.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)) {
      const tokenKey = match[1]?.trim().toLowerCase() || '';
      if (!OUTPUT_TOKEN_ALIASES[tokenKey]) {
        throw new Error(`Unsupported output path token "{{${match[1]}}}"`);
      }
    }
  }

  return normalized;
}

function resolveTemplateToken(rawToken: string, variables: OutputPathVariables): string {
  const key = rawToken.trim().toLowerCase();
  const variableName = OUTPUT_TOKEN_ALIASES[key];
  if (!variableName) {
    throw new Error(`Unsupported output path token "{{${rawToken}}}"`);
  }

  return variables[variableName];
}

export function renderOutputPathTemplate(
  template: string,
  variables: OutputPathVariables
): string {
  const normalizedTemplate = validateOutputPathTemplate(template);
  const renderedSegments = normalizedTemplate
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const withTokenValues = segment.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, rawToken) =>
        resolveTemplateToken(rawToken, variables)
      );
      const sanitized = sanitizePathSegment(withTokenValues);
      return sanitized || 'unknown';
    });

  if (renderedSegments.length === 0) {
    throw new Error('Output path template did not produce a valid folder path');
  }

  return renderedSegments.join('/');
}

export function buildOutputPathPreview(template: string): string {
  return `/${renderOutputPathTemplate(template, {
    date: '2026-04-10',
    profileName: 'Jane Doe',
    companyName: 'Acme Inc',
    jobTitle: 'Senior Engineer',
  })}`;
}

export function outputPathTemplateUsesJobTitle(template: string): boolean {
  return /\{\{\s*(job title|role)\s*\}\}/i.test(normalizeOutputPathTemplate(template));
}

export function resolveStoredFilePath(baseDir: string, relativePathValue: string): string | null {
  const normalizedBaseDir = path.resolve(baseDir);
  const normalizedRelativePath = relativePathValue
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);

  if (normalizedRelativePath.length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(normalizedBaseDir, ...normalizedRelativePath);
  if (resolvedPath !== normalizedBaseDir && !resolvedPath.startsWith(`${normalizedBaseDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}
