import puppeteer from 'puppeteer';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';
import { Profile } from '../types/profile';
import { TailoredContent, Template } from '../types/template';
import { DEFAULT_SECTION_LABELS, type SectionLabels } from '../services/jobFamilies/types';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { buildGeneratedArtifactFilename, getGeneratedFilePath } from '../utils/generatedPath';
import { clampRoleBrief, RENDERED_ROLE_BRIEF_MAX_LENGTH } from '../services/utils/roleBrief';
import {
  CHROME_LAUNCH_OPTIONS,
  CHROME_PDF_TIMEOUT_MS,
  CHROME_SET_CONTENT_TIMEOUT_MS,
} from './chrome';

const A4_PRINTABLE_WIDTH_PX = 698; // A4 width (8.27in) minus 0.5in margins on both sides at 96 DPI
const A4_PRINTABLE_HEIGHT_PX = 1026; // A4 height (11.69in) minus 0.5in margins top/bottom at 96 DPI

// Register Handlebars helpers
Handlebars.registerHelper('join', function(array: string[], separator: string) {
  if (!Array.isArray(array)) return '';
  return array.join(separator || ', ');
});

Handlebars.registerHelper('formatDate', function(date: string) {
  return date; // Keep as is for now
});

function normalizeExperienceDescriptions<T extends { experience?: Array<{ description?: string }> }>(data: T): T {
  const experience = Array.isArray(data.experience)
    ? data.experience.map((entry) => ({
      ...entry,
      // Tailored text is already clamped tighter upstream; this only bites on an
      // untailored render, where the text is the profile's own description.
      description: clampRoleBrief(entry.description ?? '', RENDERED_ROLE_BRIEF_MAX_LENGTH),
    }))
    : data.experience;

  return {
    ...data,
    experience,
  };
}

type SkillsData = {
  hardSkills?: string[];
  softSkills?: string[];
  skills?: string[];
};

/**
 * Skills reach the templates already filtered and ordered by the tailoring step, so this
 * only keeps the legacy `skills` field in step with `hardSkills` for older templates.
 */
function alignSkillFields<T extends SkillsData>(data: T): T {
  const hardSkills = data.hardSkills ?? data.skills ?? [];

  return {
    ...data,
    hardSkills,
    softSkills: data.softSkills ?? [],
    skills: hardSkills,
  } as T;
}

function getResumeTitle(profile: Profile): string {
  const profileTitle = profile.title?.trim();
  if (profileTitle) return profileTitle;
  const lastRole = profile.experience?.[0]?.title?.trim();
  return lastRole || 'Professional';
}

/**
 * Punctuation an ATS reads as a field separator in the headline: a comma, pipe or spaced
 * dash turns "Senior Engineer, New York" into a title plus a location, and brackets and
 * quotes are dropped or split by most parsers. Symbols inside a token stay because they
 * are the spelling the scorer matches on: this once stripped every symbol and rendered
 * "C++ Developer" as "C Developer" and "UI/UX Designer" as "UI UX Designer".
 */
const TITLE_SEPARATOR_PUNCTUATION = /[,;:'"()\[\]{}<>|]|\s[-–—]+\s/g;

function sanitizeTitleForATS(title: string): string {
  return title
    .replace(TITLE_SEPARATOR_PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Only a non-empty string overrides a default heading. Tailored JSON arrives from the UI's
 * draft textarea and from previews stored before labels existed, and a '' or null there
 * blanked the heading instead of falling back.
 */
export function resolveSectionLabels(
  overrides?: Partial<Record<keyof SectionLabels, unknown>> | null
): SectionLabels {
  const labels: SectionLabels = { ...DEFAULT_SECTION_LABELS };
  for (const key of Object.keys(DEFAULT_SECTION_LABELS) as Array<keyof SectionLabels>) {
    const value = overrides?.[key];
    if (typeof value === 'string' && value.trim()) labels[key] = value.trim();
  }
  return labels;
}

export function prepareResumeRenderData(
  profile: Profile,
  tailoredContent?: TailoredContent,
  companyName?: string,
  role?: string
) {
  const data = {
    ...profile,
    companyName: companyName || '',
    role: role || '',
    // The tailored headline is written for this posting; an untailored render keeps the profile title.
    title: sanitizeTitleForATS(tailoredContent?.title?.trim() || getResumeTitle(profile)),
    certifications: profile.certifications ?? [],
    labels: resolveSectionLabels(tailoredContent?.sectionLabels),
    ...(tailoredContent && {
      summary: tailoredContent.summary,
      experience: tailoredContent.experience,
      skills: tailoredContent.skills || [],
      hardSkills: tailoredContent.hardSkills || [],
      softSkills: tailoredContent.softSkills || [],
      strengths: tailoredContent.strengths
    })
  };
  return normalizeExperienceDescriptions(alignSkillFields(data));
}

export async function generateResumePDF(
  profile: Profile,
  template: Template,
  tailoredContent: TailoredContent | undefined,
  pathInfo: GeneratedPathInfo,
  companyName?: string,
  role?: string
): Promise<string> {
  const renderData = prepareResumeRenderData(
    profile,
    tailoredContent,
    companyName,
    role
  );

  // Compile and render template
  const compiledTemplate = Handlebars.compile(template.htmlContent);
  const html = compiledTemplate(renderData);

  // Add CSS if separate
  const fullHtml = template.cssContent
    ? `<style>${template.cssContent}</style>${html}`
    : html;

  // Generate PDF with Puppeteer, bounded at every step (see ./chrome): a Chrome that hangs
  // must fail this build so a later pass can retry it, not hold the route open for its
  // whole deadline and leak the browser past the close() below.
  const browser = await puppeteer.launch(CHROME_LAUNCH_OPTIONS);

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: A4_PRINTABLE_WIDTH_PX,
      height: A4_PRINTABLE_HEIGHT_PX,
      deviceScaleFactor: 1,
    });
    await page.emulateMediaType('print');
    // Templates are fully self-contained (no external CSS, fonts, or images), so 'load'
    // is sufficient; puppeteer 25 no longer accepts 'networkidle0' for setContent.
    await page.setContent(fullHtml, { waitUntil: 'load', timeout: CHROME_SET_CONTENT_TIMEOUT_MS });

    const pdfFilename = buildGeneratedArtifactFilename(pathInfo, 'resume', 'pdf');
    const relativePath = `${pathInfo.storagePathBase}/${pdfFilename}`;
    const filepath = path.join(pathInfo.absoluteDir, pdfFilename);
    const finalPdf = Buffer.from(await page.pdf({
      format: 'A4',
      margin: {
        top: '0.4in',
        right: '0.5in',
        bottom: '0.3in',
        left: '0.5in'
      },
      printBackground: true,
      timeout: CHROME_PDF_TIMEOUT_MS
    }));

    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, finalPdf);

    return relativePath;
  } finally {
    await browser.close();
  }
}

export async function generatePreviewHTML(
  profile: Profile,
  template: Template,
  tailoredContent?: TailoredContent
): Promise<string> {
  const renderData = prepareResumeRenderData(profile, tailoredContent);

  // Compile and render template
  const compiledTemplate = Handlebars.compile(template.htmlContent);
  const html = compiledTemplate(renderData);

  // Add CSS if separate
  return template.cssContent
    ? `<style>${template.cssContent}</style>${html}`
    : html;
}

/** Sample profile for template preview */
const SAMPLE_PROFILE: Profile = {
  id: 'preview',
  name: 'Jane Smith',
  title: 'Senior Software Engineer',
  totalYearsExperience: 5,
  contact: {
    phone: '+1 (555) 123-4567',
    email: 'jane.smith@email.com',
    linkedin: 'linkedin.com/in/janesmith',
    location: 'San Francisco, CA',
  },
  summary: 'Experienced software engineer with 5+ years building scalable web applications. Strong focus on clean code and team collaboration.',
  experience: [
    {
      title: 'Senior Software Engineer',
      company: 'Tech Corp',
      startDate: '01/2021',
      endDate: 'Present',
      location: 'San Francisco, CA',
      description: 'Lead development of customer-facing platforms.',
      achievements: ['Reduced load time by 40%', 'Mentored 3 junior engineers'],
    },
    {
      title: 'Software Engineer',
      company: 'Startup Inc',
      startDate: '06/2019',
      endDate: '12/2020',
      location: 'Remote',
      description: 'Full-stack development for SaaS product.',
      achievements: ['Built REST APIs', 'Implemented CI/CD pipeline'],
    },
  ],
  strengths: [
    { title: 'Problem Solving', description: 'Analytical approach to complex challenges.' },
    { title: 'Communication', description: 'Clear technical documentation and presentations.' },
  ],
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python'],
  education: [
    {
      degree: 'B.S. Computer Science',
      institution: 'State University',
      startDate: '2015',
      endDate: '2019',
      location: 'Boston, MA',
    },
  ],
  // The admin gallery renders this profile, so a broken certifications block shows up there.
  certifications: [
    { name: 'AWS Certified Solutions Architect', issuer: 'Amazon Web Services', date: '2022', expiryDate: '2025' },
  ],
  createdAt: '',
  updatedAt: '',
};

export function generateTemplatePreviewHTML(template: Template): string {
  const renderData = prepareResumeRenderData(SAMPLE_PROFILE);
  const compiledTemplate = Handlebars.compile(template.htmlContent);
  const html = compiledTemplate(renderData);
  const fullHtml = template.cssContent
    ? `<style>${template.cssContent}</style>${html}`
    : html;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:8px;background:#f3f4f6;">${fullHtml}</body></html>`;
}

export async function getGeneratedPDFPath(filename: string): Promise<string | null> {
  return getGeneratedFilePath(filename);
}
