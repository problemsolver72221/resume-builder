import fs from 'fs/promises';
import path from 'path';
import pdf from 'pdf-parse';
import { extractTemplateFromPDF } from '../services/claude';
import { Template } from '../types/template';
import { v4 as uuidv4 } from 'uuid';
import { isSafeId } from '../utils/safeId';

const DATA_DIR = process.env.TAILOR_DATA_DIR
  ? path.resolve(process.env.TAILOR_DATA_DIR)
  : path.join(__dirname, '../../data');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

async function ensureDirectories() {
  try {
    await fs.access(TEMPLATES_DIR);
  } catch {
    await fs.mkdir(TEMPLATES_DIR, { recursive: true });
  }
  try {
    await fs.access(UPLOADS_DIR);
  } catch {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
  }
}

export async function extractAndSaveTemplate(
  pdfBuffer: Buffer,
  templateName: string,
  originalFilename: string
): Promise<Template> {
  await ensureDirectories();

  // Parse PDF to extract text
  const pdfData = await pdf(pdfBuffer);
  const pdfText = pdfData.text;

  if (!pdfText || pdfText.trim().length < 50) {
    throw new Error('Could not extract sufficient text from PDF');
  }

  // Save the original PDF
  const pdfId = uuidv4();
  const pdfPath = path.join(UPLOADS_DIR, `${pdfId}.pdf`);
  await fs.writeFile(pdfPath, pdfBuffer);

  // Use Claude to extract template
  const { html, css, sections } = await extractTemplateFromPDF(pdfText, templateName);

  // Create template object
  const template: Template = {
    id: uuidv4(),
    name: templateName,
    description: `Template extracted from ${originalFilename}`,
    htmlContent: html,
    cssContent: css || '',
    sections,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Save template
  const templatePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
  await fs.writeFile(templatePath, JSON.stringify(template, null, 2));

  return template;
}

async function findTemplateFiles(dir: string, baseDir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      files.push(...(await findTemplateFiles(fullPath, baseDir)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(relativePath.replace(/\\/g, '/'));
    }
  }
  return files;
}

export async function getAllTemplates(): Promise<Template[]> {
  await ensureDirectories();

  const relativePaths = await findTemplateFiles(TEMPLATES_DIR, TEMPLATES_DIR);
  const templates: Template[] = [];

  for (const relPath of relativePaths) {
    const templatePath = path.join(TEMPLATES_DIR, relPath);
    try {
      const content = await fs.readFile(templatePath, 'utf-8');
      const parsed = JSON.parse(content) as Template;
      const id = relPath.replace(/\.json$/, '');
      templates.push({ ...parsed, id });
    } catch {
      console.warn(`Skipped invalid template: ${relPath}`);
    }
  }

  return templates.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getTemplateById(id: string): Promise<Template | null> {
  const normalizedId = id.replace(/\.json$/, '');
  if (!isSafeId(normalizedId, { allowSlash: true })) return null;
  const templatePath = path.join(TEMPLATES_DIR, `${normalizedId}.json`);
  try {
    const content = await fs.readFile(templatePath, 'utf-8');
    const parsed = JSON.parse(content) as Template;
    return { ...parsed, id: normalizedId };
  } catch {
    return null;
  }
}

export async function updateTemplate(id: string, updates: Partial<Pick<Template, 'disabled' | 'name' | 'description'>>): Promise<Template | null> {
  const template = await getTemplateById(id);
  if (!template) return null;

  const updated: Template = {
    ...template,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const normalizedId = id.replace(/\.json$/, '');
  const templatePath = path.join(TEMPLATES_DIR, `${normalizedId}.json`);
  await fs.writeFile(templatePath, JSON.stringify(updated, null, 2));
  return updated;
}

const BUILT_IN_TEMPLATE_IDS = new Set([
  'default', 'one-column', 'one-column-modern',
  'two-column-navy', 'one-column-emerald', 'one-column-violet', 'one-column-rose',
  'two-column-slate', 'one-column-amber', 'one-column-indigo', 'two-column-minimal',
  'one-column-serif', 'two-column-teal', 'one-column-coral', 'two-column-forest',
]);

export async function uploadJsonTemplate(
  jsonBuffer: Buffer,
  options?: { overrideId?: string }
): Promise<Template> {
  await ensureDirectories();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBuffer.toString('utf-8'));
  } catch (e) {
    throw new Error('Invalid JSON: ' + (e instanceof Error ? e.message : 'Parse error'));
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj || typeof obj !== 'object') {
    throw new Error('Template must be a JSON object');
  }

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const htmlContent = typeof obj.htmlContent === 'string' ? obj.htmlContent : '';
  const sections = Array.isArray(obj.sections) ? obj.sections.filter((s): s is string => typeof s === 'string') : [];

  if (!name) throw new Error('Template must have a "name" field');
  if (!htmlContent || htmlContent.length < 100) {
    throw new Error('Template must have "htmlContent" with valid HTML');
  }
  if (sections.length === 0) {
    throw new Error('Template must have a "sections" array');
  }

  let id = typeof obj.id === 'string' ? obj.id.replace(/\.json$/, '').trim() : '';
  if (options?.overrideId) id = options.overrideId.replace(/\.json$/, '').trim();
  if (!id || BUILT_IN_TEMPLATE_IDS.has(id)) {
    id = `u-${uuidv4().slice(0, 8)}`;
  }
  id = id.replace(/[^a-zA-Z0-9\-_]/g, '-');

  const existing = await getTemplateById(id);
  if (existing) {
    id = `u-${uuidv4().slice(0, 8)}`;
  }

  const now = new Date().toISOString();
  const template: Template = {
    id,
    name,
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
    disabled: typeof obj.disabled === 'boolean' ? obj.disabled : false,
    htmlContent,
    cssContent: typeof obj.cssContent === 'string' ? obj.cssContent : '',
    sections,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : now,
    updatedAt: now,
    ...(obj.manualConfig && typeof obj.manualConfig === 'object'
      ? { manualConfig: obj.manualConfig as Template['manualConfig'] }
      : {}),
  };

  const templatePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
  await fs.writeFile(templatePath, JSON.stringify(template, null, 2));
  return template;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const normalizedId = id.replace(/\.json$/, '');
  if (!isSafeId(normalizedId, { allowSlash: true })) return false;
  const templatePath = path.join(TEMPLATES_DIR, `${normalizedId}.json`);
  try {
    await fs.unlink(templatePath);
    return true;
  } catch {
    return false;
  }
}

export async function createDefaultTemplate(): Promise<Template> {
  await ensureDirectories();
  const existingDefault = await getTemplateById('default');
  if (existingDefault) {
    return existingDefault;
  }

  const defaultTemplate: Template = {
    id: 'default',
    name: 'Two-Column Professional',
    description: '2-column ATS-friendly resume template with strengths, skills, education and certifications on the right',
    htmlContent: buildDefaultTemplateHTML(),
    cssContent: '',
    sections: [...MANUAL_SECTIONS],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const defaultTemplatePath = path.join(TEMPLATES_DIR, `${defaultTemplate.id}.json`);
  await fs.writeFile(defaultTemplatePath, JSON.stringify(defaultTemplate, null, 2));

  return defaultTemplate;
}

/** Stylesheet of the built-in template; the manual builder derives its own from its config. */
const DEFAULT_TEMPLATE_STYLE = `
    @page {
      margin: 0.3in;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: Calibri, 'Segoe UI', Arial, sans-serif;
      font-size: 9pt;
      line-height: 1.25;
      color: #000;
      margin: 0;
      padding: 0;
    }
    .section:last-child {
      margin-bottom: 0;
    }
    .header {
      text-align: center;
      margin-bottom: 8px;
      border-bottom: 2px solid #2563eb;
      padding-bottom: 8px;
    }
    .name {
      font-size: 24pt;
      font-weight: bold;
      color: #1e40af;
      margin-bottom: 2px;
    }
    .title {
      font-size: 10pt;
      color: #1e40af;
      margin-bottom: 4px;
    }
    .contact {
      font-size: 8pt;
      color: #333;
      display: flex;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .contact-item {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .contact-icon {
      color: #2563eb;
    }
    .contact a {
      color: #000;
      text-decoration: none;
    }
    .main-container {
      display: flex;
      gap: 15px;
    }
    .left-column {
      flex: 0 0 62%;
    }
    .right-column {
      flex: 0 0 35%;
    }
    .section {
      margin-bottom: 8px;
    }
    .section-title {
      font-size: 10pt;
      font-weight: bold;
      color: #1e40af;
      text-transform: uppercase;
      border-bottom: 1px solid #1e40af;
      padding-bottom: 2px;
      margin-bottom: 5px;
    }
    .summary {
      font-size: 9pt;
      line-height: 1.3;
      text-align: justify;
    }
    .experience-item {
      margin-bottom: 8px;
    }
    .job-title {
      font-weight: bold;
      font-size: 10pt;
      color: #1e40af;
    }
    .company-line {
      display: flex;
      justify-content: space-between;
      font-size: 9pt;
      color: #555;
      margin-bottom: 2px;
    }
    .description {
      font-size: 9pt;
      margin-bottom: 3px;
      line-height: 1.3;
    }
    .achievements {
      margin: 0;
      padding-left: 14px;
      font-size: 8.5pt;
    }
    .achievements li {
      margin-bottom: 1px;
      line-height: 1.25;
    }
    .strength-item {
      margin-bottom: 8px;
    }
    .strength-header {
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 2px;
    }
    .strength-icon {
      color: #f59e0b;
      font-size: 10pt;
    }
    .strength-title {
      font-weight: bold;
      font-size: 9pt;
      color: #1e40af;
    }
    .strength-description {
      font-size: 8pt;
      color: #555;
      line-height: 1.3;
    }
    .skills-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
    }
    .skill-box {
      font-size: 8pt;
      padding: 2px 0;
      border-bottom: 1px solid #ddd;
      text-align: center;
    }
    .education-item {
      margin-bottom: 6px;
    }
    .degree {
      font-weight: bold;
      font-size: 9pt;
      color: #1e40af;
    }
    .institution {
      font-size: 8pt;
      color: #555;
    }
    .edu-date {
      font-size: 8pt;
      color: #777;
    }
`;

export interface ElementStyle {
  color: string;
  fontSizePt: number;
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
}

export interface ManualTemplateConfig {
  name: string;
  description?: string;
  columns: 1 | 2;
  accentColor: string;
  bodyColor: string;
  bodyFontSizePt: number;
  titleFontSizePt: number;
  /** For 1 column: order of all sections. For 2 columns: ignored. */
  sectionOrder?: string[];
  /** For 2 columns: order of sections in left column (summary, experience) */
  leftSectionOrder?: string[];
  /** For 2 columns: order of sections in right column (strengths, hardSkills, softSkills, education, certifications) */
  rightSectionOrder?: string[];
  /** Header: person name */
  nameStyle?: Partial<ElementStyle>;
  /** Header: professional title */
  headerTitleStyle?: Partial<ElementStyle>;
  /** Header: contact info (phone, email, etc.) */
  contactStyle?: Partial<ElementStyle>;
  /** Main title (name) and section titles */
  titleStyle?: Partial<ElementStyle>;
  /** Job title, degree, strength title */
  subTitleStyle?: Partial<ElementStyle>;
  /** Body text: summary, description, paragraphs */
  paragraphStyle?: Partial<ElementStyle>;
  /** Per-section, per-element overrides: sectionId -> elementId -> { color, fontSizePt, fontFamily?, fontWeight? } */
  sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
}

/**
 * One Handlebars block per resume section, shared by the built-in default template and the
 * manual builder. Each used to carry its own copy of this markup and the two drifted; adding
 * a section is now one entry here. The skills, strengths and certifications headings come
 * from `labels` (see prepareResumeRenderData) because a nursing or sales posting should not
 * render under "Hard Skills". `data-section` is what the manual builder's per-section style
 * overrides target.
 */
const SECTION_BLOCKS = {
  summary: `
      <div class="section" data-section="summary">
        <div class="section-title">Summary</div>
        <div class="summary">{{summary}}</div>
      </div>`,
  experience: `
      <div class="section" data-section="experience">
        <div class="section-title">Experience</div>
        {{#each experience}}
        <div class="experience-item">
          <div class="job-title">{{title}}</div>
          <div class="company-line">
            <span>{{company}}</span>
            <span>{{startDate}} - {{endDate}}{{#if location}} | {{location}}{{/if}}</span>
          </div>
          <div class="description">{{description}}</div>
          <ul class="achievements">
            {{#each achievements}}
            <li>{{this}}</li>
            {{/each}}
          </ul>
        </div>
        {{/each}}
      </div>`,
  strengths: `
      {{#if strengths.length}}
      <div class="section" data-section="strengths">
        <div class="section-title">{{labels.strengths}}</div>
        {{#each strengths}}
        <div class="strength-item">
          <div class="strength-header">
            <span class="strength-icon">★</span>
            <span class="strength-title">{{title}}</span>
          </div>
          <div class="strength-description">{{description}}</div>
        </div>
        {{/each}}
      </div>
      {{/if}}`,
  hardSkills: `
      <div class="section" data-section="hardSkills">
        <div class="section-title">{{labels.hardSkills}}</div>
        <div class="skills-grid">
          {{#if hardSkills.length}}
          {{#each hardSkills}}
          <div class="skill-box">{{this}}</div>
          {{/each}}
          {{else}}
          {{#each skills}}
          <div class="skill-box">{{this}}</div>
          {{/each}}
          {{/if}}
        </div>
      </div>`,
  softSkills: `
      {{#if softSkills.length}}
      <div class="section" data-section="softSkills">
        <div class="section-title">{{labels.softSkills}}</div>
        <div class="skills-grid">
          {{#each softSkills}}
          <div class="skill-box">{{this}}</div>
          {{/each}}
        </div>
      </div>
      {{/if}}`,
  education: `
      <div class="section" data-section="education">
        <div class="section-title">Education</div>
        {{#each education}}
        <div class="education-item">
          <div class="degree">{{degree}}</div>
          <div class="institution">{{institution}}</div>
          <div class="edu-date">{{startDate}} - {{endDate}}{{#if location}} | {{location}}{{/if}}</div>
        </div>
        {{/each}}
      </div>`,
  certifications: `
      {{#if certifications.length}}
      <div class="section" data-section="certifications">
        <div class="section-title">{{labels.certifications}}</div>
        {{#each certifications}}
        <div class="education-item">
          <div class="degree">{{name}}</div>
          <div class="institution">{{issuer}}</div>
          <div class="edu-date">{{date}}{{#if expiryDate}} - {{expiryDate}}{{/if}}</div>
        </div>
        {{/each}}
      </div>
      {{/if}}`,
} as const satisfies Record<string, string>;

export type ManualSection = keyof typeof SECTION_BLOCKS;

/** Every section a template can list, in the default one-column order. */
export const MANUAL_SECTIONS = Object.keys(SECTION_BLOCKS) as ManualSection[];

const isManualSection = (section: string): section is ManualSection =>
  Object.prototype.hasOwnProperty.call(SECTION_BLOCKS, section);

/** Default split when switching to 2 columns; any section can go in either column */
const DEFAULT_LEFT: readonly ManualSection[] = ['summary', 'experience'];
const DEFAULT_RIGHT: readonly ManualSection[] = ['strengths', 'hardSkills', 'softSkills', 'education', 'certifications'];

function getBlockForSection(section: string): string {
  return isManualSection(section) ? SECTION_BLOCKS[section] : '';
}

/** Name, headline and contact line; identical in the built-in and manual templates. */
const HEADER_BLOCK = `  <div class="header">
    <div class="name">{{name}}</div>
    <div class="title">{{title}}</div>
    <div class="contact">
      <span class="contact-item"><span class="contact-icon">📞</span> {{contact.phone}}</span>
      <span class="contact-item"><span class="contact-icon">✉</span> {{contact.email}}</span>
      {{#if contact.linkedin}}<span class="contact-item"><span class="contact-icon">🔗</span> <a href="{{contact.linkedin}}">{{contact.linkedin}}</a></span>{{/if}}
      <span class="contact-item"><span class="contact-icon">📍</span> {{contact.location}}</span>
    </div>
  </div>`;

/**
 * The built-in two-column template, composed from SECTION_BLOCKS so it cannot drift from
 * the manual builder. Written to disk only when no default.json exists yet.
 */
export function buildDefaultTemplateHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${DEFAULT_TEMPLATE_STYLE}
  </style>
</head>
<body>
${HEADER_BLOCK}

  <div class="main-container">
    <div class="left-column">${DEFAULT_LEFT.map(getBlockForSection).join('\n')}
    </div>

    <div class="right-column">${DEFAULT_RIGHT.map(getBlockForSection).join('\n')}
    </div>
  </div>
</body>
</html>`;
}

export function buildManualTemplateHTML(config: ManualTemplateConfig): string {
  const {
    accentColor,
    bodyColor,
    bodyFontSizePt,
    titleFontSizePt,
    sectionOrder = [],
    leftSectionOrder = [],
    rightSectionOrder = [],
    columns = 1,
    nameStyle,
    headerTitleStyle,
    contactStyle,
    titleStyle,
    subTitleStyle,
    paragraphStyle,
    sectionStyles = {},
  } = config;

  const ELEMENT_TO_CLASS: Record<string, string> = {
    sectionTitle: '.section-title',
    paragraph: '.summary',
    jobTitle: '.job-title',
    companyLine: '.company-line',
    description: '.description',
    achievements: '.achievements',
    strengthTitle: '.strength-title',
    strengthDescription: '.strength-description',
    skillText: '.skill-box',
    degree: '.degree',
    institution: '.institution',
    date: '.edu-date',
  };
  const accent = accentColor || '#1e40af';
  const body = bodyColor || '#000';
  const bodyPt = bodyFontSizePt || 9;
  const titlePt = titleFontSizePt || 24;

  const name = {
    color: nameStyle?.color ?? accent,
    size: nameStyle?.fontSizePt ?? titlePt,
    font: nameStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: nameStyle?.fontWeight ?? 'bold',
  };
  const headerTitle = {
    color: headerTitleStyle?.color ?? accent,
    size: headerTitleStyle?.fontSizePt ?? bodyPt + 1,
    font: headerTitleStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: headerTitleStyle?.fontWeight ?? 'bold',
  };
  const contact = {
    color: contactStyle?.color ?? '#333',
    size: contactStyle?.fontSizePt ?? bodyPt - 1,
    font: contactStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: contactStyle?.fontWeight ?? 'normal',
  };
  const t = {
    color: titleStyle?.color ?? accent,
    size: titleStyle?.fontSizePt ?? titlePt,
    font: titleStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: titleStyle?.fontWeight ?? 'bold',
  };
  const st = {
    color: subTitleStyle?.color ?? accent,
    size: subTitleStyle?.fontSizePt ?? bodyPt + 1,
    font: subTitleStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: subTitleStyle?.fontWeight ?? 'bold',
  };
  const p = {
    color: paragraphStyle?.color ?? body,
    size: paragraphStyle?.fontSizePt ?? bodyPt,
    font: paragraphStyle?.fontFamily || "Calibri, 'Segoe UI', Arial, sans-serif",
    weight: paragraphStyle?.fontWeight ?? 'normal',
  };

  const orderedSections = sectionOrder.filter((s) => isManualSection(s));
  if (orderedSections.length === 0) {
    orderedSections.push(...MANUAL_SECTIONS);
  }

  const leftOrder =
    columns === 2 && leftSectionOrder.length > 0
      ? leftSectionOrder.filter((s) => isManualSection(s))
      : [...DEFAULT_LEFT];
  const rightOrder =
    columns === 2 && rightSectionOrder.length > 0
      ? rightSectionOrder.filter((s) => isManualSection(s))
      : [...DEFAULT_RIGHT];

  const sectionBlocks =
    columns === 1
      ? orderedSections.map(getBlockForSection).filter(Boolean)
      : [];
  const leftBlocks = columns === 2 ? leftOrder.map(getBlockForSection).filter(Boolean) : [];
  const rightBlocks = columns === 2 ? rightOrder.map(getBlockForSection).filter(Boolean) : [];

  const mainContent =
    columns === 2
      ? `<div class="main-container">
    <div class="left-column">${leftBlocks.join('\n')}</div>
    <div class="right-column">${rightBlocks.join('\n')}</div>
  </div>`
      : `<div class="main-content">${sectionBlocks.join('\n')}</div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page { margin: 0.3in; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${p.font};
      font-size: ${p.size}pt;
      line-height: 1.25;
      color: ${p.color};
      font-weight: ${p.weight};
      margin: 0;
      padding: 0;
    }
    .header {
      text-align: center;
      margin-bottom: 8px;
      border-bottom: 2px solid ${accent};
      padding-bottom: 8px;
    }
    .name {
      font-size: ${name.size}pt;
      font-weight: ${name.weight};
      font-family: ${name.font};
      color: ${name.color};
      margin-bottom: 2px;
    }
    .title {
      font-size: ${headerTitle.size}pt;
      font-weight: ${headerTitle.weight};
      font-family: ${headerTitle.font};
      color: ${headerTitle.color};
      margin-bottom: 4px;
    }
    .contact {
      font-size: ${contact.size}pt;
      font-family: ${contact.font};
      color: ${contact.color};
      display: flex;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .contact-item { display: flex; align-items: center; gap: 3px; }
    .contact-icon { color: ${accent}; }
    .contact a { color: ${contact.color}; text-decoration: none; }
    .main-container { display: flex; gap: 15px; }
    .left-column { flex: 0 0 62%; }
    .right-column { flex: 0 0 35%; }
    .section { margin-bottom: 8px; }
    .section-title {
      font-size: ${t.size}pt;
      font-weight: ${t.weight};
      font-family: ${t.font};
      color: ${t.color};
      text-transform: uppercase;
      border-bottom: 1px solid ${accent};
      padding-bottom: 2px;
      margin-bottom: 5px;
    }
    .summary { font-size: ${p.size}pt; font-family: ${p.font}; color: ${p.color}; font-weight: ${p.weight}; line-height: 1.3; text-align: justify; }
    .experience-item { margin-bottom: 8px; }
    .job-title { font-weight: ${st.weight}; font-size: ${st.size}pt; font-family: ${st.font}; color: ${st.color}; }
    .company-line {
      display: flex;
      justify-content: space-between;
      font-size: ${p.size}pt;
      font-family: ${p.font};
      color: #555;
      margin-bottom: 2px;
    }
    .description { font-size: ${p.size}pt; font-family: ${p.font}; color: ${p.color}; font-weight: ${p.weight}; margin-bottom: 3px; line-height: 1.3; }
    .achievements { margin: 0; padding-left: 14px; font-size: ${p.size - 0.5}pt; font-family: ${p.font}; color: ${p.color}; }
    .achievements li { margin-bottom: 1px; line-height: 1.25; }
    .strength-item { margin-bottom: 8px; }
    .strength-header { display: flex; align-items: center; gap: 5px; margin-bottom: 2px; }
    .strength-icon { color: #f59e0b; font-size: ${st.size}pt; }
    .strength-title { font-weight: ${st.weight}; font-size: ${st.size}pt; font-family: ${st.font}; color: ${st.color}; }
    .strength-description { font-size: ${p.size - 1}pt; font-family: ${p.font}; color: #555; line-height: 1.3; }
    .skills-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 8px;
    }
    .skill-box {
      font-size: ${p.size - 1}pt;
      font-family: ${p.font};
      color: ${p.color};
      padding: 2px 0;
      border-bottom: 1px solid #ddd;
      text-align: center;
    }
    .education-item { margin-bottom: 6px; }
    .degree { font-weight: ${st.weight}; font-size: ${st.size}pt; font-family: ${st.font}; color: ${st.color}; }
    .institution { font-size: ${p.size - 1}pt; font-family: ${p.font}; color: #555; }
    .edu-date { font-size: ${p.size - 1}pt; font-family: ${p.font}; color: #777; }
    ${Object.entries(sectionStyles)
      .map(([sectionId, elements]) =>
        Object.entries(elements)
          .map(([elementId, style]) => {
            const cls = ELEMENT_TO_CLASS[elementId];
            if (!cls || (!style.color && style.fontSizePt == null && !style.fontFamily && !style.fontWeight)) return '';
            const parts: string[] = [];
            if (style.color) parts.push(`color: ${style.color}`);
            if (style.fontSizePt != null) parts.push(`font-size: ${style.fontSizePt}pt`);
            if (style.fontFamily) parts.push(`font-family: ${style.fontFamily}`);
            if (style.fontWeight) parts.push(`font-weight: ${style.fontWeight}`);
            return parts.length ? `[data-section="${sectionId}"] ${cls} { ${parts.join('; ')} }` : '';
          })
          .filter(Boolean)
          .join('\n    ')
      )
      .filter(Boolean)
      .join('\n    ')}
  </style>
</head>
<body>
${HEADER_BLOCK}
${mainContent}
</body>
</html>`;
}

export async function createManualTemplate(config: ManualTemplateConfig): Promise<Template> {
  await ensureDirectories();

  const sectionOrder = config.sectionOrder?.length
    ? config.sectionOrder.filter((s) => isManualSection(s))
    : [...MANUAL_SECTIONS];

  const fullConfig = {
    ...config,
    sectionOrder,
    leftSectionOrder: config.leftSectionOrder,
    rightSectionOrder: config.rightSectionOrder,
    accentColor: config.accentColor || '#1e40af',
    bodyColor: config.bodyColor || '#000',
    bodyFontSizePt: config.bodyFontSizePt ?? 9,
    titleFontSizePt: config.titleFontSizePt ?? 24,
  };

  const template: Template = {
    id: `m-${uuidv4().slice(0, 8)}`,
    name: config.name.trim() || 'Manual Template',
    description: config.description?.trim() || 'Manually styled template',
    htmlContent: buildManualTemplateHTML(fullConfig),
    cssContent: '',
    sections: sectionOrder,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    manualConfig: fullConfig as Template['manualConfig'],
  };

  const templatePath = path.join(TEMPLATES_DIR, `${template.id}.json`);
  await fs.writeFile(templatePath, JSON.stringify(template, null, 2));

  return { ...template, id: template.id };
}

export async function updateManualTemplate(id: string, config: ManualTemplateConfig): Promise<Template | null> {
  const template = await getTemplateById(id);
  if (!template) return null;
  if (!template.id.startsWith('m-')) {
    throw new Error('Only manual templates can be updated');
  }

  const sectionOrder = config.sectionOrder?.length
    ? config.sectionOrder.filter((s) => isManualSection(s))
    : [...MANUAL_SECTIONS];

  const fullConfig = {
    ...config,
    sectionOrder,
    leftSectionOrder: config.leftSectionOrder,
    rightSectionOrder: config.rightSectionOrder,
    accentColor: config.accentColor || '#1e40af',
    bodyColor: config.bodyColor || '#000',
    bodyFontSizePt: config.bodyFontSizePt ?? 9,
    titleFontSizePt: config.titleFontSizePt ?? 24,
  };

  const updated: Template = {
    ...template,
    name: config.name.trim() || template.name,
    description: config.description?.trim() ?? template.description,
    htmlContent: buildManualTemplateHTML(fullConfig),
    sections: sectionOrder,
    updatedAt: new Date().toISOString(),
    manualConfig: fullConfig as Template['manualConfig'],
  };

  const templatePath = path.join(TEMPLATES_DIR, `${id.replace(/\.json$/, '')}.json`);
  await fs.writeFile(templatePath, JSON.stringify(updated, null, 2));
  return updated;
}
