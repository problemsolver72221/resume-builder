import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { analyzeJobDescription, tailorResume, generateCoverLetter } from '../services/claude';
import { resolveModelSelection, UnknownModelError, type ModelSelection } from '../providers/registry';
import { classifyFailure } from '../providers/retry';
import { requestDeadline } from '../middleware/requestDeadline';
import { isSafeId } from '../utils/safeId';
import { generateResumePDF, generatePreviewHTML, getGeneratedPDFPath } from '../generators/pdfGenerator';
import { generateResumeDOCX } from '../generators/docxGenerator';
import { saveCoverLetter, saveCoverLetterDOCX } from '../generators/coverLetterGenerator';
import {
  findExistingArtifacts,
  getGeneratedOutputPath,
  listExpectedArtifacts,
  normalizeOutputDate,
  type ExistingArtifacts,
} from '../utils/generatedPath';
import { getTemplateById, createDefaultTemplate } from '../extractors/templateExtractor';
import { getAIModelSettings, getDefaultEnabledProvider, getPublicAppSettings, isProviderEnabled, type AIModelSettings } from '../config/aiModelConfig';
import { confirmSkill, createSkill, deleteSkillHandler, listSkills, updateSkillHandler } from '../controllers/skills';
import { Profile } from '../types/profile';
import { GenerateResumeRequest, ResumeFormat, TailoredContent } from '../types/template';

const router = Router();
// Every resume route answers within BUILD_DEADLINE_MS or with a retryable 503; see the middleware.
router.use(requestDeadline());
const PROFILES_DIR = path.join(__dirname, '../../data/profiles');

function shouldGenerateCoverLetterDocx(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

/**
 * Whether this request wants a cover letter at all. Off means the tailoring call stops
 * asking the model for one — the single largest slice of output tokens in the run — and no
 * letter files are written. An absent flag falls back to the admin default.
 */
function shouldGenerateCoverLetter(value: unknown, defaultEnabled: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultEnabled;
}

/**
 * The model a request named, or null after answering 400. A model the provider does not
 * list is refused outright: silently running its default instead would bill the wrong model.
 */
function resolveRequestedModel(model: unknown, res: Response): ModelSelection | null {
  try {
    return resolveModelSelection(typeof model === 'string' ? model : undefined);
  } catch (error) {
    if (error instanceof UnknownModelError) {
      res.status(400).json({ error: error.message });
      return null;
    }
    throw error;
  }
}

/** As resolveRequestedModel, and also 400 when the admin has disabled that provider. */
function selectRequestedModel(model: unknown, settings: AIModelSettings, res: Response): ModelSelection | null {
  const selection = resolveRequestedModel(model, res);
  if (!selection) return null;
  if (!isProviderEnabled(selection.providerId, settings)) {
    res.status(400).json({ error: `Selected AI model '${selection.providerId}' is disabled by admin` });
    return null;
  }
  return selection;
}

/**
 * The failure's message plus whether the same request can succeed later: 503 for a provider
 * having a bad moment (the batch in the browser retries those), 500 for one that needs a
 * person — key, credits, model access, a malformed request.
 */
function respondWithFailure(res: Response, error: unknown, fallback: string): void {
  const { retryable, retryLater } = classifyFailure(error);
  // `retryLater`: not re-sent within the call, but worth a later pass (the builders wait
  // minutes between passes) — a model too slow for the request just now, a model that declined once.
  res
    .status(retryable || retryLater ? 503 : 500)
    .json({ error: error instanceof Error ? error.message : fallback, retryable, retryLater: retryLater ?? false });
}

function resolveGenerationRole(role: unknown, analysis?: import('../types/template').JobAnalysis): string {
  if (typeof role === 'string' && role.trim()) {
    return role.trim();
  }
  return analysis?.jobMeta?.title?.trim() || '';
}

function normalizeResumeFormat(value: unknown, fallback: ResumeFormat): ResumeFormat {
  return value === 'both' || value === 'docx' || value === 'pdf' ? value : fallback;
}

function toDownload(filename: string | undefined): { filename: string; downloadUrl: string } {
  // findExistingArtifacts only answers when every requested file is present, and the
  // generators always return a name, so a missing one here is a programming error.
  if (!filename) throw new Error('Generated artifact path is missing');
  return { filename, downloadUrl: `/api/resume/download/${filename}` };
}

/** Present only when a letter exists, so the client can tell "off" from "written". */
function buildCoverLetterPayload(pdf: string | undefined, docx: string | undefined) {
  return pdf ? { coverLetter: { pdf: toDownload(pdf), ...(docx ? { docx: toDownload(docx) } : {}) } } : {};
}

/**
 * The same response shape /generate returns after generating, built from files that were
 * already on disk. `skipped` is the only difference, so a caller that ignores it sees a
 * completed build either way.
 */
function describeExistingGeneration(existing: ExistingArtifacts, format: ResumeFormat, tailored: boolean, outputDate: string) {
  const common = {
    outputDate,
    ...buildCoverLetterPayload(existing.coverLetterPdf, existing.coverLetterDocx),
    tailored,
    skipped: true as const,
    unconfirmedHardSkills: [] as string[],
    unconfirmedSoftSkills: [] as string[],
  };
  if (format === 'both') {
    return { pdf: toDownload(existing.resumePdf), docx: toDownload(existing.resumeDocx), ...common };
  }
  return { ...toDownload(format === 'docx' ? existing.resumeDocx : existing.resumePdf), format, ...common };
}

// Get enabled AI models
router.get('/models', async (req: Request, res: Response) => {
  try {
    const settings = await getPublicAppSettings();
    res.json(settings);
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Confirm and persist a new skill
router.post('/skills/confirm', confirmSkill);


// List skills
router.get('/skills', listSkills);

// Add skill
router.post('/skills', createSkill);

// Update skill
router.put('/skills', updateSkillHandler);

// Delete skill
router.delete('/skills', deleteSkillHandler);

// Analyze job description
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { jobDescription, model } = req.body as { jobDescription?: string; model?: string };

    if (!jobDescription || jobDescription.trim().length < 50) {
      res.status(400).json({ error: 'Job description must be at least 50 characters' });
      return;
    }

    const settings = await getAIModelSettings();
    const requested = resolveRequestedModel(model, res);
    if (!requested) return;
    const target = isProviderEnabled(requested.providerId, settings) ? requested : getDefaultEnabledProvider(settings);
    const analysis = await analyzeJobDescription(jobDescription, target);
    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing job description:', error);
    respondWithFailure(res, error, 'Failed to analyze job description');
  }
});

// Load all non-disabled profiles
async function loadAllProfiles(profileIds?: string[]): Promise<Profile[]> {
  const selectedIds = Array.isArray(profileIds)
    ? new Set(profileIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))
    : null;
  const files = await fs.readdir(PROFILES_DIR);
  const profiles: Profile[] = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const content = await fs.readFile(path.join(PROFILES_DIR, file), 'utf-8');
        const profile = JSON.parse(content) as Profile;
        if (profile.disabled) continue;
        if (selectedIds && !selectedIds.has(profile.id)) continue;
        profiles.push(profile);
      } catch {
        // Skip invalid profile files
      }
    }
  }
  return profiles.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// Generate for all profiles at once
router.post('/generate-all', async (req: Request, res: Response) => {
  try {
    const {
      templateId,
      jobDescription,
      jobAnalysis,
      companyName,
      role,
      model,
      profileIds,
      format = 'both',
      includeCoverLetterDocx,
      includeCoverLetter,
      skipExisting,
      outputDate,
    } = req.body;

    // Load setting
    const settings = await getAIModelSettings();
    const appSettings = await getPublicAppSettings();
    const selectedModel = selectRequestedModel(model, settings, res);
    if (!selectedModel) return;

    if (!companyName?.trim()) {
      res.status(400).json({ error: 'Company name is required' });
      return;
    }

    // Load profiles
    const profiles = await loadAllProfiles(profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: 'No matching profiles available. Add profiles in Admin or update group members.' });
      return;
    }

    await createDefaultTemplate();

    let analysis: import('../types/template').JobAnalysis | undefined;

    const trimmedJobDescription = jobDescription?.trim();

    if (trimmedJobDescription && trimmedJobDescription.length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(trimmedJobDescription, selectedModel);
    }

    const resolvedRole = resolveGenerationRole(role, analysis);
    if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
      res.status(400).json({ error: 'Role is required' });
      return;
    }

    const normalizedCompanyName = companyName.trim();
    const results: {
      profileId: string;
      profileName: string;
      pdf?: string;
      docx?: string;
      coverLetterPdf?: string;
      coverLetterDocx?: string;
      /** Files were already on disk; nothing was generated or spent for this profile. */
      skipped?: boolean;
    }[] = [];
    const failures: Array<{ profileId: string; profileName: string; companyName: string; error: string; retryable?: boolean }> = [];
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();
    const formatNorm = normalizeResumeFormat(format, 'both');
    const generateCoverLetterDocx = shouldGenerateCoverLetterDocx(includeCoverLetterDocx);
    const coverLetterEnabled = shouldGenerateCoverLetter(includeCoverLetter, appSettings.defaultCoverLetterEnabled);
    const expectedArtifacts = listExpectedArtifacts({
      format: formatNorm,
      coverLetter: coverLetterEnabled,
      coverLetterDocx: generateCoverLetterDocx,
    });
    let skippedCount = 0;
    // Every profile in this call shares one date folder: the caller's when it pinned one,
    // otherwise whatever the first build resolved. Letting each profile resolve "today" on
    // its own split a run that crossed midnight across two folders, and left skip-existing
    // unable to find the files the earlier profiles had just written.
    let runOutputDate = normalizeOutputDate(outputDate);

    for (const profile of profiles) {
      if (!profile) continue;
      try {
        const profileTemplateId = profile.preferredTemplate ?? templateId ?? 'default';
        let template = await getTemplateById(profileTemplateId);
        if (!template || template.disabled) template = await getTemplateById('default');
        if (!template || template.disabled) {
          throw new Error('Default template not available');
        }

        const pathInfo = await getGeneratedOutputPath(profile, normalizedCompanyName, resolvedRole, {
          outputDate: runOutputDate,
        });
        if (!runOutputDate) runOutputDate = pathInfo.outputDate;
        // Settled before tailoring so a resumed batch spends nothing on work it already has.
        if (skipExisting === true) {
          const existing = await findExistingArtifacts(pathInfo, expectedArtifacts);
          if (existing) {
            results.push({
              profileId: profile.id,
              profileName: profile.name,
              pdf: existing.resumePdf,
              docx: existing.resumeDocx,
              coverLetterPdf: existing.coverLetterPdf,
              coverLetterDocx: existing.coverLetterDocx,
              skipped: true,
            });
            skippedCount += 1;
            continue;
          }
        }

        let tailoredContent;
        if (analysis) {
          tailoredContent = await tailorResume(profile, analysis, trimmedJobDescription ?? '', selectedModel, {
            includeCoverLetter: coverLetterEnabled,
          });
        }
        if (tailoredContent) {
          for (const skill of tailoredContent.unconfirmedHardSkills ?? []) {
            const key = skill.trim().toLowerCase();
            if (key && !unconfirmedHardMap.has(key)) {
              unconfirmedHardMap.set(key, skill.trim());
            }
          }
          for (const skill of tailoredContent.unconfirmedSoftSkills ?? []) {
            const key = skill.trim().toLowerCase();
            if (key && !unconfirmedSoftMap.has(key)) {
              unconfirmedSoftMap.set(key, skill.trim());
            }
          }
        }

        let coverLetterPdfPath: string | undefined;
        let coverLetterDocxPath: string | undefined;
        if (coverLetterEnabled) {
          // Falls back to a dedicated call only when the tailoring reply carried no letter,
          // which is the untailored path — never when the letter was switched off.
          const coverLetterBody = tailoredContent?.coverLetter?.trim()
            || await generateCoverLetter(profile, normalizedCompanyName, resolvedRole, selectedModel);
          coverLetterPdfPath = await saveCoverLetter(profile, coverLetterBody, pathInfo, tailoredContent?.coverLetterStyle);
          coverLetterDocxPath = generateCoverLetterDocx
            ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo, tailoredContent?.coverLetterStyle)
            : undefined;
        }

        const entry: (typeof results)[0] = {
          profileId: profile.id,
          profileName: profile.name,
          coverLetterPdf: coverLetterPdfPath,
          coverLetterDocx: coverLetterDocxPath,
        };
        if (formatNorm === 'both') {
          const [pdfFilename, docxFilename] = await Promise.all([
            generateResumePDF(profile, template, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole),
            generateResumeDOCX(profile, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole)
          ]);
          entry.pdf = pdfFilename;
          entry.docx = docxFilename;
        } else {
          const filename = formatNorm === 'docx'
            ? await generateResumeDOCX(profile, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole)
            : await generateResumePDF(profile, template, tailoredContent, pathInfo, normalizedCompanyName, resolvedRole);
          entry[formatNorm] = filename;
        }
        results.push(entry);
      } catch (profileError) {
        const message = profileError instanceof Error ? profileError.message : 'Failed to generate resume';
        console.error(`Error generating resume for profile ${profile.id} (${profile.name}) at ${normalizedCompanyName}:`, profileError);
        failures.push({
          profileId: profile.id,
          profileName: profile.name,
          companyName: normalizedCompanyName,
          error: message,
          retryable: classifyFailure(profileError).retryable,
        });
      }
    }

    res.json({
      generated: results.length - skippedCount,
      skipped: skippedCount,
      results,
      failed: failures.length,
      failures,
      failedCompanies: failures.length > 0 ? [normalizedCompanyName] : [],
      tailored: !!analysis,
      // Returned so a caller running several of these can pin later calls to this folder.
      outputDate: runOutputDate,
      unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
    });
  } catch (error) {
    console.error('Error generating resumes for all profiles:', error);
    respondWithFailure(res, error, 'Failed to generate resumes');
  }
});

// Preview resumes for all profiles
router.post('/preview-all', async (req: Request, res: Response) => {
  try {
    const {
      templateId,
      jobDescription,
      jobAnalysis,
      model,
      profileIds,
      includeCoverLetter,
    } = req.body as {
      templateId?: string;
      jobDescription?: string;
      jobAnalysis?: import('../types/template').JobAnalysis;
      model?: string;
      profileIds?: string[];
      includeCoverLetter?: boolean;
    };

    const settings = await getAIModelSettings();
    const appSettings = await getPublicAppSettings();
    const selectedModel = selectRequestedModel(model, settings, res);
    if (!selectedModel) return;

    const profiles = await loadAllProfiles(profileIds);
    if (profiles.length === 0) {
      res.status(400).json({ error: 'No matching profiles available. Add profiles in Admin or update group members.' });
      return;
    }

    await createDefaultTemplate();

    let analysis: import('../types/template').JobAnalysis | undefined;
    const trimmedJobDescription = jobDescription?.trim();
    if (trimmedJobDescription && trimmedJobDescription.length > 50) {
      analysis = jobAnalysis || await analyzeJobDescription(trimmedJobDescription, selectedModel);
    }

    const previews: Array<{
      profileId: string;
      profileName: string;
      html: string;
      tailoredContent?: TailoredContent;
    }> = [];
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();

    for (const profile of profiles) {
      if (!profile) continue;
      const profileTemplateId = profile.preferredTemplate ?? templateId ?? 'default';
      let template = await getTemplateById(profileTemplateId);
      if (!template || template.disabled) template = await getTemplateById('default');
      if (!template || template.disabled) {
        res.status(500).json({ error: 'Default template not available' });
        return;
      }

      let tailoredContent: TailoredContent | undefined;
      if (analysis) {
        // Previews feed straight into generation, so they must agree on the letter or the
        // model would be paid twice — once for a preview letter, once for the real one.
        tailoredContent = await tailorResume(profile, analysis, trimmedJobDescription ?? '', selectedModel, {
          includeCoverLetter: shouldGenerateCoverLetter(includeCoverLetter, appSettings.defaultCoverLetterEnabled),
        });
      }

      if (tailoredContent) {
        for (const skill of tailoredContent.unconfirmedHardSkills ?? []) {
          const key = skill.trim().toLowerCase();
          if (key && !unconfirmedHardMap.has(key)) {
            unconfirmedHardMap.set(key, skill.trim());
          }
        }
        for (const skill of tailoredContent.unconfirmedSoftSkills ?? []) {
          const key = skill.trim().toLowerCase();
          if (key && !unconfirmedSoftMap.has(key)) {
            unconfirmedSoftMap.set(key, skill.trim());
          }
        }
      }

      const html = await generatePreviewHTML(profile, template, tailoredContent);
      previews.push({
        profileId: profile.id,
        profileName: profile.name,
        html,
        tailoredContent,
      });
    }

    res.json({
      previews,
      tailored: !!analysis,
      unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
    });
  } catch (error) {
    console.error('Error previewing resumes for all profiles:', error);
    respondWithFailure(res, error, 'Failed to preview resumes');
  }
});

// Generate tailored resume (single profile)
/**
 * Whether a build's files are already on disk, decided from the path alone: no model call,
 * no template. A batch asks this before analysing a job, so a re-imported or resumed sheet
 * pays only for the builds it still has to make. Anything that cannot be resolved to a
 * path answers "no", and the generate route then decides for real.
 */
router.post('/existing', async (req: Request, res: Response) => {
  try {
    const { profileId, companyName, role, format = 'pdf', includeCoverLetterDocx, includeCoverLetter, outputDate } =
      req.body as Partial<GenerateResumeRequest>;
    if (!profileId || !isSafeId(profileId) || !companyName || !companyName.trim()) {
      res.json({ exists: false });
      return;
    }
    let profile: Profile;
    try {
      profile = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, `${profileId}.json`), 'utf-8'));
    } catch {
      res.json({ exists: false });
      return;
    }
    const appSettings = await getPublicAppSettings();
    const resolvedRole = resolveGenerationRole(role);
    if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
      res.json({ exists: false });
      return;
    }
    const pathInfo = await getGeneratedOutputPath(profile, companyName.trim(), resolvedRole, { outputDate: normalizeOutputDate(outputDate) });
    const existing = await findExistingArtifacts(
      pathInfo,
      listExpectedArtifacts({
        format: normalizeResumeFormat(format, 'pdf'),
        coverLetter: shouldGenerateCoverLetter(includeCoverLetter, appSettings.defaultCoverLetterEnabled),
        coverLetterDocx: shouldGenerateCoverLetterDocx(includeCoverLetterDocx),
      })
    );
    res.json({ exists: !!existing, outputDate: pathInfo.outputDate });
  } catch (error) {
    respondWithFailure(res, error, 'Failed to check existing files');
  }
});

router.post('/generate', async (req: Request, res: Response) => {
  try {
    const {
      profileId,
      templateId,
      jobDescription,
      jobAnalysis,
      companyName,
      role,
      model,
      format = 'pdf',
      includeCoverLetterDocx,
      includeCoverLetter,
      skipExisting,
      outputDate,
    }: GenerateResumeRequest = req.body;
    const settings = await getAIModelSettings();
    const appSettings = await getPublicAppSettings();
    const selectedModel = selectRequestedModel(model, settings, res);
    if (!selectedModel) return;

    if (!profileId) {
      res.status(400).json({ error: 'Profile ID is required' });
      return;
    }
    if (!isSafeId(profileId)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    if (!companyName || !companyName.trim()) {
      res.status(400).json({ error: 'Company name is required' });
      return;
    }

    // Load profile
    const profilePath = path.join(PROFILES_DIR, `${profileId}.json`);
    let profile: Profile;
    try {
      const content = await fs.readFile(profilePath, 'utf-8');
      profile = JSON.parse(content);
    } catch {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    if (profile.disabled) {
      res.status(400).json({ error: 'Selected profile is disabled' });
      return;
    }

    // Ensure built-in templates exist, then load requested template
    await createDefaultTemplate();
    let template = await getTemplateById(templateId || 'default');
    if (!template) {
      template = await getTemplateById('default');
    }
    if (!template) {
      res.status(500).json({ error: 'Default template not available' });
      return;
    }
    if (template.disabled) {
      res.status(400).json({ error: 'Selected template is disabled' });
      return;
    }

    const coverLetterEnabled = shouldGenerateCoverLetter(includeCoverLetter, appSettings.defaultCoverLetterEnabled);
    const generateCoverLetterDocx = shouldGenerateCoverLetterDocx(includeCoverLetterDocx);
    const formatNorm = normalizeResumeFormat(format, 'pdf');
    const trimmedJobDescription = jobDescription?.trim() ?? '';
    const wantsTailoring = trimmedJobDescription.length > 50;

    // Manual edits from a preview arrive as finished content and are never re-tailored.
    let tailoredContent = (req.body as GenerateResumeRequest).tailoredContent as TailoredContent | undefined;

    // The role decides the output path, so it is settled before any tailoring. A batch sends
    // its analysis along and this costs nothing; only a bare job description pays for an
    // analysis here, and that is the cheap call.
    let analysis = jobAnalysis;
    if (!tailoredContent && wantsTailoring && !analysis) {
      analysis = await analyzeJobDescription(trimmedJobDescription, selectedModel);
    }
    const resolvedRole = resolveGenerationRole(role, analysis);
    if (appSettings.outputPathUsesJobTitle && !resolvedRole) {
      res.status(400).json({ error: 'Role is required' });
      return;
    }
    const pathInfo = await getGeneratedOutputPath(profile, companyName.trim(), resolvedRole, { outputDate: normalizeOutputDate(outputDate) });

    // A restarted batch resumes here instead of paying to regenerate what it already has.
    if (skipExisting === true) {
      const existing = await findExistingArtifacts(
        pathInfo,
        listExpectedArtifacts({ format: formatNorm, coverLetter: coverLetterEnabled, coverLetterDocx: generateCoverLetterDocx })
      );
      if (existing) {
        res.json(describeExistingGeneration(existing, formatNorm, wantsTailoring || !!tailoredContent, pathInfo.outputDate));
        return;
      }
    }

    if (!tailoredContent && wantsTailoring && analysis) {
      tailoredContent = await tailorResume(profile, analysis, trimmedJobDescription, selectedModel, {
        includeCoverLetter: coverLetterEnabled,
      });
    }

    const generateBoth = formatNorm === 'both';
    const unconfirmedHardSkills = tailoredContent?.unconfirmedHardSkills ?? [];
    const unconfirmedSoftSkills = tailoredContent?.unconfirmedSoftSkills ?? [];

    let coverLetterPdfPath: string | undefined;
    let coverLetterDocxPath: string | undefined;
    if (coverLetterEnabled) {
      // The dedicated call is the untailored path only: with a job description the letter
      // already arrived with the tailored content, and when switched off there is none.
      const coverLetterBody = tailoredContent?.coverLetter?.trim()
        || await generateCoverLetter(profile, companyName.trim(), resolvedRole, selectedModel);
      coverLetterPdfPath = await saveCoverLetter(profile, coverLetterBody, pathInfo, tailoredContent?.coverLetterStyle);
      coverLetterDocxPath = generateCoverLetterDocx
        ? await saveCoverLetterDOCX(profile, coverLetterBody, pathInfo, tailoredContent?.coverLetterStyle)
        : undefined;
    }

    const coverLetterPayload = buildCoverLetterPayload(coverLetterPdfPath, coverLetterDocxPath);

    if (generateBoth) {
      const [pdfFilename, docxFilename] = await Promise.all([
        generateResumePDF(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole),
        generateResumeDOCX(profile, tailoredContent, pathInfo, companyName.trim(), resolvedRole),
      ]);
      res.json({
        pdf: { filename: pdfFilename, downloadUrl: `/api/resume/download/${pdfFilename}` },
        docx: { filename: docxFilename, downloadUrl: `/api/resume/download/${docxFilename}` },
        ...coverLetterPayload,
        tailored: !!tailoredContent,
        outputDate: pathInfo.outputDate,
        unconfirmedHardSkills,
        unconfirmedSoftSkills,
      });
    } else {
      const singleFormat = formatNorm === 'docx' ? 'docx' : 'pdf';
      const filename =
        singleFormat === 'docx'
          ? await generateResumeDOCX(profile, tailoredContent, pathInfo, companyName.trim(), resolvedRole)
          : await generateResumePDF(profile, template, tailoredContent, pathInfo, companyName.trim(), resolvedRole);

      res.json({
        filename,
        downloadUrl: `/api/resume/download/${filename}`,
        ...coverLetterPayload,
        tailored: !!tailoredContent,
        format: singleFormat,
        outputDate: pathInfo.outputDate,
        unconfirmedHardSkills,
        unconfirmedSoftSkills,
      });
    }
  } catch (error) {
    console.error('Error generating resume:', error);
    respondWithFailure(res, error, 'Failed to generate resume');
  }
});

// Preview resume HTML
router.post('/preview', async (req: Request, res: Response) => {
  try {
    const {
      profileId,
      templateId,
      jobDescription,
      jobAnalysis,
      tailoredContent: manualTailoredContent,
      model,
      includeCoverLetter,
    }: GenerateResumeRequest = req.body;
    const settings = await getAIModelSettings();
    const appSettings = await getPublicAppSettings();
    const selectedModel = selectRequestedModel(model, settings, res);
    if (!selectedModel) return;

    if (!profileId) {
      res.status(400).json({ error: 'Profile ID is required' });
      return;
    }
    if (!isSafeId(profileId)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    // Load profile
    const profilePath = path.join(PROFILES_DIR, `${profileId}.json`);
    let profile: Profile;
    try {
      const content = await fs.readFile(profilePath, 'utf-8');
      profile = JSON.parse(content);
    } catch {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }
    if (profile.disabled) {
      res.status(400).json({ error: 'Selected profile is disabled' });
      return;
    }

    // Ensure built-in templates exist, then load requested template
    await createDefaultTemplate();
    let template = await getTemplateById(templateId || 'default');
    if (!template) {
      template = await getTemplateById('default');
    }
    if (!template) {
      res.status(500).json({ error: 'Default template not available' });
      return;
    }
    if (template.disabled) {
      res.status(400).json({ error: 'Selected template is disabled' });
      return;
    }

    // If job description provided, tailor the resume (unless overridden by manual edits)
    let tailoredContent = manualTailoredContent;
    if (!tailoredContent && jobDescription && jobDescription.trim().length > 50) {
      const analysis = jobAnalysis || await analyzeJobDescription(jobDescription, selectedModel);
      tailoredContent = await tailorResume(profile, analysis, jobDescription, selectedModel, {
        includeCoverLetter: shouldGenerateCoverLetter(includeCoverLetter, appSettings.defaultCoverLetterEnabled),
      });
    }

    // Generate HTML preview
    const html = await generatePreviewHTML(profile, template, tailoredContent);

    res.json({ html, tailored: !!tailoredContent, tailoredContent });
  } catch (error) {
    console.error('Error generating preview:', error);
    respondWithFailure(res, error, 'Failed to generate preview');
  }
});

// Download generated resume (PDF or DOCX)
router.get('/download/:filename(*)', async (req: Request<{ filename: string }>, res: Response) => {
  try {
    const filepath = await getGeneratedPDFPath(req.params.filename);
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const ext = path.extname(req.params.filename).toLowerCase();
    const contentType =
      ext === '.docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/pdf';

    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.params.filename)}"`);
    res.setHeader('Content-Type', contentType);
    res.download(filepath);
  } catch (error) {
    res.status(500).json({ error: 'Failed to download file' });
  }
});

export default router;
