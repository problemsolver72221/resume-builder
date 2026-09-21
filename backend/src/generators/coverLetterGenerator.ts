import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
/// <reference path="../types/html-to-docx.d.ts" />
import HTMLtoDOCX from 'html-to-docx';
import { Profile } from '../types/profile';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { buildGeneratedArtifactFilename } from '../utils/generatedPath';
import { toNodeBuffer } from '../utils/binary';
import { createCoverLetterVariation, type CoverLetterStyle } from '../services/coverLetterVariation';
import {
  CHROME_LAUNCH_OPTIONS,
  CHROME_PDF_TIMEOUT_MS,
  CHROME_SET_CONTENT_TIMEOUT_MS,
} from './chrome';

/**
 * Falls back to a fresh random style. Callers that write both a PDF and a DOCX must pass
 * the same style to both, or the two files for one application will not match.
 */
function resolveStyle(style?: CoverLetterStyle): CoverLetterStyle {
  return style ?? createCoverLetterVariation().style;
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert plain text content to HTML paragraphs, italicising the last one when asked. */
function contentToHtmlParagraphs(content: string, style: CoverLetterStyle): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());
  return paragraphs
    .map((p, index) => {
      const italic =
        style.italic === 'closing-paragraph' && index === paragraphs.length - 1
          ? ' font-style: italic;'
          : '';
      return `<p style="margin: 0 0 12pt 0; line-height: ${style.lineHeight};${italic}">${esc(
        p.trim().replace(/\n/g, ' ')
      )}</p>`;
    })
    .join('\n  ');
}

function bodyStyle(style: CoverLetterStyle): string {
  return `font-family: ${style.fontCss}; font-size: ${style.fontSizePt}pt; color: ${style.colorHex}; line-height: ${style.lineHeight};`;
}

const italicIf = (on: boolean): string => (on ? ' font-style: italic;' : '');

/**
 * Build professional PDF-style HTML for the cover letter.
 * Structure: {greeting}, {content}, {sign-off}, {Profile name}
 */
function buildCoverLetterHTML(content: string, profileName: string, style: CoverLetterStyle): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="${bodyStyle(style)}">
  <p style="margin: 0 0 12pt 0;${italicIf(style.italic === 'greeting')}">${esc(style.greeting)}</p>
  ${contentToHtmlParagraphs(content, style)}
  <p style="margin: 12pt 0 6pt 0;${italicIf(style.italic === 'signoff')}">${esc(style.signOff)}</p>
  <p style="margin: 0;">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Build cover letter HTML for DOCX with explicit line breaks between sections.
 * Structure: {greeting}, (line break), {content}, (line break), {sign-off}, {profile name}
 */
function buildCoverLetterHTMLForDocx(content: string, profileName: string, style: CoverLetterStyle): string {
  const lineBreak = '<p style="margin: 0 0 12pt 0;"></p>';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="${bodyStyle(style)}">
  <p style="margin: 0 0 12pt 0;${italicIf(style.italic === 'greeting')}">${esc(style.greeting)}</p>
  ${lineBreak}
  ${contentToHtmlParagraphs(content, style)}
  ${lineBreak}
  <p style="margin: 0 0 12pt 0;${italicIf(style.italic === 'signoff')}">${esc(style.signOff)}</p>
  <p style="margin: 0; font-weight: bold; font-size: ${style.fontSizePt + 1}pt;">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Save cover letter as PDF in the same directory as the resume.
 * Path: {profile}/{date}/{company}/{role}/{Profile}-Cover-Letter-{Role}.pdf
 */
export async function saveCoverLetter(
  profile: Profile,
  content: string,
  pathInfo: GeneratedPathInfo,
  style?: CoverLetterStyle
): Promise<string> {
  const filename = buildGeneratedArtifactFilename(pathInfo, 'coverletter', 'pdf');
  const relativePath = `${pathInfo.storagePathBase}/${filename}`;
  const filepath = path.join(pathInfo.absoluteDir, filename);

  const html = buildCoverLetterHTML(content.trim(), profile.name, resolveStyle(style));

  // Bounded at every step, from the values in ./chrome that the resume render also reads:
  // a Chrome that hangs must fail the build (which is then retried) rather than hold it
  // open indefinitely. These used to be written out here and nowhere else, which is how
  // the resume render ended up with no bounds at all.
  const browser = await puppeteer.launch(CHROME_LAUNCH_OPTIONS);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 595, height: 842, deviceScaleFactor: 1 }); // A4 at 72 DPI
    await page.emulateMediaType('print');
    // Self-contained HTML; see the note in pdfGenerator.
    await page.setContent(html, { waitUntil: 'load', timeout: CHROME_SET_CONTENT_TIMEOUT_MS });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
      printBackground: true,
      timeout: CHROME_PDF_TIMEOUT_MS,
    });

    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, Buffer.from(pdfBuffer));

    return relativePath;
  } finally {
    await browser.close();
  }
}

/**
 * Save cover letter as DOCX in the same directory as the resume.
 * Path: {profile}/{date}/{company}/{role}/{Profile}-Cover-Letter-{Role}.docx
 */
export async function saveCoverLetterDOCX(
  profile: Profile,
  content: string,
  pathInfo: GeneratedPathInfo,
  style?: CoverLetterStyle
): Promise<string> {
  const resolved = resolveStyle(style);
  const filename = buildGeneratedArtifactFilename(pathInfo, 'coverletter', 'docx');
  const relativePath = `${pathInfo.storagePathBase}/${filename}`;
  const filepath = path.join(pathInfo.absoluteDir, filename);

  const html = buildCoverLetterHTMLForDocx(content.trim(), profile.name, resolved);

  const docxBuffer = await HTMLtoDOCX(html, null, {
    font: resolved.fontDocx,
    fontSize: Math.round(resolved.fontSizePt * 2), // half-points
    margins: { top: 1080, right: 1080, bottom: 1080, left: 1080 }, // 0.75in in twips
    orientation: 'portrait',
  });

  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, await toNodeBuffer(docxBuffer));

  return relativePath;
}
