'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  profilesApi,
  groupsApi,
  resumeApi,
  ModelChoice,
  PublicAppSettings,
  Profile,
  Group,
  JobAnalysis,
  TailoredContent,
} from '@/lib/api';
import AppTopNav from '@/components/AppTopNav';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import ProfileSelector from '@/components/ProfileSelector';
import ResumePreview from '@/components/ResumePreview';
import SheetsImportModal from '@/components/SheetsImportModal';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { listModelOptions, pickDefaultModel } from '@/lib/providers';
import { formatCountdown, retryUntilSuccess } from '@/lib/retry';
import {
  clearBatchRun,
  createBatchRun,
  describeRunSource,
  loadBatchRun,
  saveBatchRun,
  summarizeBatchRun,
  wasInterrupted,
  type BatchRun,
} from '@/lib/batchState';
import { getAnalysisJobTitle, runBatch as runBatchModel } from '@/features/builder/model/batchRunner';
import { buildPort } from '@/features/builder/model/apiBuildPort';
import type { BatchOutcome, ImportedSheetJob } from '@/features/builder/model/types';

type GenerateMode = 'single' | 'multiple';
type BuilderMode = 'manual' | 'sheets' | null;
type SheetsTargetMode = 'single' | 'all' | 'group';

type UnconfirmedSkill = { original: string; value: string };

type SwitchRowProps = {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

/** A labelled on/off switch in the builder's option list; the row tints amber while off. */
function SwitchRow({ title, description, checked, onChange, disabled }: SwitchRowProps) {
  return (
    <div
      className={`flex items-center justify-between border rounded-lg p-4 transition-colors ${
        checked ? 'border-gray-200 bg-white' : 'border-amber-200 bg-amber-50'
      }`}
    >
      <div>
        <div className="text-sm font-semibold text-gray-800">
          {title} {checked ? '(On)' : '(Off)'}
        </div>
        <div className="text-xs text-gray-600">{description}</div>
      </div>
      <label className="inline-flex items-center cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="sr-only"
        />
        <span
          className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-400'}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-5 w-5 bg-white rounded-full transition-transform ${
              checked ? 'translate-x-5' : ''
            }`}
          />
        </span>
      </label>
    </div>
  );
}

type MultiplePreview = {
  profileId: string;
  profileName: string;
  html: string;
  tailoredContent?: TailoredContent;
  draft: string;
  error: string;
};

/** Seconds a reloaded page waits before continuing an interrupted run on its own. */
const AUTO_RESUME_SECONDS = 20;

function formatCompanySummary(companyNames: string[]): string {
  const uniqueCompanies = [...new Set(companyNames.map((name) => name.trim()).filter(Boolean))];
  if (uniqueCompanies.length === 0) return '';
  if (uniqueCompanies.length <= 3) return uniqueCompanies.join(', ');
  return `${uniqueCompanies.slice(0, 3).join(', ')}, ...`;
}

/** Settings shape used until the backend answers (or when it cannot be reached). */
const EMPTY_APP_SETTINGS: PublicAppSettings = {
  providers: [],
  defaultProviderId: '',
  defaultMode: 'preview',
  defaultTheme: 'light',
  defaultResumeSelection: 'single',
  defaultGroupId: '',
  defaultProfileId: '',
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
  defaultCoverLetterEnabled: true,
  outputPathUsesJobTitle: true,
  googleSheetsSources: [],
};

export default function Home() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [builderMode, setBuilderMode] = useState<BuilderMode>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [generateMode, setGenerateMode] = useState<GenerateMode>('single');
  const [multipleTarget, setMultipleTarget] = useState<'all' | 'group'>('group');
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [sheetsTargetMode, setSheetsTargetMode] = useState<SheetsTargetMode>('single');
  const [selectedSheetsProfileId, setSelectedSheetsProfileId] = useState<string | null>(null);
  const [selectedSheetsGroupId, setSelectedSheetsGroupId] = useState<string>('');
  const [selectedSheetsSourceId, setSelectedSheetsSourceId] = useState<string>('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [selectedModel, setSelectedModel] = useState<ModelChoice>('');
  const [modelSettings, setModelSettings] = useState<PublicAppSettings>(EMPTY_APP_SETTINGS);
  const [jobAnalysis, setJobAnalysis] = useState<JobAnalysis | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTailored, setPreviewTailored] = useState(false);
  const [isSinglePreviewOpen, setIsSinglePreviewOpen] = useState(false);
  const [tailoredContent, setTailoredContent] = useState<TailoredContent | null>(null);
  const [tailoredContentDraft, setTailoredContentDraft] = useState('');
  const [tailoredContentError, setTailoredContentError] = useState('');
  const [unconfirmedHardSkills, setUnconfirmedHardSkills] = useState<UnconfirmedSkill[]>([]);
  const [unconfirmedSoftSkills, setUnconfirmedSoftSkills] = useState<UnconfirmedSkill[]>([]);
  const [multiplePreviews, setMultiplePreviews] = useState<MultiplePreview[]>([]);
  const [multiplePreviewTailored, setMultiplePreviewTailored] = useState(false);
  const [multiplePreviewIndex, setMultiplePreviewIndex] = useState(0);
  const [autoGenerate, setAutoGenerate] = useState(false);
  // Seeded from the admin default once settings load, then owned by this run.
  const [includeCoverLetter, setIncludeCoverLetter] = useState(true);
  // Sheets batches only: a build whose files are already on disk is skipped, so a run that
  // was interrupted picks up where it stopped instead of paying for every job again.
  const [skipExistingBuilds, setSkipExistingBuilds] = useState(true);
  const [isSheetsImportOpen, setIsSheetsImportOpen] = useState(false);

  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState('');
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressState | null>(null);
  // Set by the Stop button; every retry loop checks it between builds and while waiting.
  const stopRequestedRef = useRef(false);
  const isStopRequested = () => stopRequestedRef.current;
  const requestStop = () => {
    stopRequestedRef.current = true;
    setGenerationStep('Stopping after the current build...');
  };
  const beginGeneration = () => {
    stopRequestedRef.current = false;
    setIsGenerating(true);
  };
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  // The last Sheets import, kept in localStorage so it can be resumed after a stop, a
  // closed tab, or failures that needed a person.
  const [savedRun, setSavedRun] = useState<BatchRun | null>(null);
  // Countdown to continuing a run whose loop died in a reload or a closed tab; null when none is due.
  const [autoResumeIn, setAutoResumeIn] = useState<number | null>(null);
  useEffect(() => {
    const run = loadBatchRun();
    setSavedRun(run);
    if (run && wasInterrupted(run)) setAutoResumeIn(AUTO_RESUME_SECONDS);
  }, []);

  // A reload or a closed tab ends the loop; the browser asks first while builds are running.
  useEffect(() => {
    if (!isGenerating) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isGenerating]);

  useEffect(() => {
    loadInitialData();
  }, []);

  const resetTailoredEditor = useCallback(() => {
    setTailoredContent(null);
    setTailoredContentDraft('');
    setTailoredContentError('');
  }, []);

  const resetGenerationOutputs = useCallback(() => {
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setSuccessMessage('');
    setUnconfirmedHardSkills([]);
    setUnconfirmedSoftSkills([]);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);
  }, [resetTailoredEditor]);

  useEffect(() => {
    resetGenerationOutputs();
  }, [builderMode, companyName, role, jobDescription, selectedProfileId, selectedModel, generateMode, resetGenerationOutputs]);

  const loadInitialData = async () => {
    try {
      const [profilesData, groupsData, modelData] = await Promise.all([
        profilesApi.getAll({ includeDisabled: true }),
        groupsApi.getAll().catch(() => []),
        resumeApi.getModels().catch(() => EMPTY_APP_SETTINGS),
      ]);
      const enabledProfiles = profilesData.filter((p) => !p.disabled);
      setProfiles(enabledProfiles);
      setGroups(groupsData);
      setModelSettings(modelData);
      setAutoGenerate(modelData.defaultMode === 'generate');
      setIncludeCoverLetter(modelData.defaultCoverLetterEnabled);
      setStoredDefaultTheme(modelData.defaultTheme);

      if (!getStoredTheme()) {
        applyTheme(modelData.defaultTheme);
      }

      setSelectedModel((current) => pickDefaultModel(modelData, current));

      if (enabledProfiles.length > 0) {
        const defaultProfileExists = enabledProfiles.some((profile) => profile.id === modelData.defaultProfileId);
        const initialProfileId = defaultProfileExists ? modelData.defaultProfileId : enabledProfiles[0].id;
        setSelectedProfileId(initialProfileId);
        setSelectedSheetsProfileId(initialProfileId);
      }

      setSelectedSheetsSourceId((current) => {
        if (current && modelData.googleSheetsSources.some((source) => source.id === current)) {
          return current;
        }
        return modelData.googleSheetsSources[0]?.id ?? '';
      });

      if (modelData.defaultResumeSelection === 'single') {
        setGenerateMode('single');
        setMultipleTarget('group');
        setSelectedGroupId('');
        setSheetsTargetMode('single');
        setSelectedSheetsGroupId('');
      } else if (modelData.defaultResumeSelection === 'all') {
        setGenerateMode('multiple');
        setMultipleTarget('all');
        setSelectedGroupId('');
        setSheetsTargetMode('all');
        setSelectedSheetsGroupId('');
      } else {
        const defaultGroupExists = groupsData.some((group) => group.id === modelData.defaultGroupId);
        setGenerateMode('multiple');
        setMultipleTarget('group');
        const initialGroupId = defaultGroupExists ? modelData.defaultGroupId : '';
        setSelectedGroupId(initialGroupId);
        setSheetsTargetMode('group');
        setSelectedSheetsGroupId(initialGroupId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoadingData(false);
    }
  };

  const toUnconfirmedItems = (skills?: string[]) =>
    (skills ?? []).map((skill) => ({ original: skill, value: skill }));

  const getDefaultGenerationOptions = () => ({
    format: (modelSettings.defaultResumeDocxEnabled ? 'both' : 'pdf') as 'both' | 'pdf',
    includeCoverLetterDocx: modelSettings.defaultCoverLetterDocxEnabled,
    includeCoverLetter,
  });
  const shouldShowRoleInput = modelSettings.outputPathUsesJobTitle;
  const hasGoogleSheetSources = modelSettings.googleSheetsSources.length > 0;

  useEffect(() => {
    if (hasGoogleSheetSources || !isSheetsImportOpen) return;
    setIsSheetsImportOpen(false);
  }, [hasGoogleSheetSources, isSheetsImportOpen]);

  const getSelectedProfilesForSheetsBuilder = () => {
    if (sheetsTargetMode === 'single') {
      if (!selectedSheetsProfileId) {
        throw new Error('Please select a profile before importing from Sheets.');
      }
      const profile = profiles.find((item) => item.id === selectedSheetsProfileId);
      if (!profile) {
        throw new Error('Selected profile could not be found.');
      }
      return [profile];
    }

    if (sheetsTargetMode === 'all') {
      if (!profiles.length) {
        throw new Error('No profiles available for batch generation.');
      }
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedSheetsGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group before importing from Sheets.');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  const aggregateUnconfirmedFromPreviews = (previews: MultiplePreview[]) => {
    const hardMap = new Map<string, string>();
    const softMap = new Map<string, string>();
    for (const preview of previews) {
      const content = preview.tailoredContent;
      for (const skill of content?.unconfirmedHardSkills ?? []) {
        const key = skill.trim().toLowerCase();
        if (key && !hardMap.has(key)) hardMap.set(key, skill.trim());
      }
      for (const skill of content?.unconfirmedSoftSkills ?? []) {
        const key = skill.trim().toLowerCase();
        if (key && !softMap.has(key)) softMap.set(key, skill.trim());
      }
    }
    return {
      hard: toUnconfirmedItems(Array.from(hardMap.values())),
      soft: toUnconfirmedItems(Array.from(softMap.values())),
    };
  };

  const clearGenerationProgress = () => {
    setGenerationProgress(null);
  };

  const updateGenerationProgress = (
    total: number,
    completed: number,
    phase: string,
    currentProfileName?: string,
    currentCompanyName?: string
  ) => {
    setGenerationProgress({
      total,
      completed,
      phase,
      currentProfileName,
      currentCompanyName,
    });
  };

  const describeRetryWait = (pass: number, remainingMs: number, failing: number, lastError: string) =>
    `Retry pass ${pass} in ${formatCountdown(remainingMs)} — still failing (${failing}): ${lastError}`;
  /** For one operation (an analysis, a preview, a single build) retried until it succeeds. */
  const singleRetryHooks = {
    isCancelled: isStopRequested,
    onWait: ({ pass, remainingMs, error }: { pass: number; remainingMs: number; error: string }) =>
      setGenerationStep(describeRetryWait(pass, remainingMs, 1, error)),
  };

  const getSelectedProfilesForManualBuilder = (): Profile[] => {
    if (multipleTarget === 'all') {
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  /**
   * The manual builder's multi-profile generation: one job × the chosen profiles. It is a
   * saved run like a Sheets import, so a reload, a crash or a stop leaves something to
   * resume instead of a few resumes and no record of the rest.
   */
  const generateSequentialResumes = async ({
    targetProfiles,
    analysis,
    targetCompanyName,
    resolvedRole,
    tailoredContentByProfileId,
  }: {
    targetProfiles: Profile[];
    analysis?: JobAnalysis;
    targetCompanyName: string;
    resolvedRole: string;
    tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
  }): Promise<BatchOutcome> => {
    const job: ImportedSheetJob = {
      sourceRowNumber: 1,
      companyName: targetCompanyName,
      jobTitle: resolvedRole,
      jobDescription,
    };
    const run = createBatchRun({
      source: 'manual',
      model: selectedModel,
      profiles: targetProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
      jobs: [job],
      // Analysed before the run starts; null means "build untailored", exactly as before.
      analyses: { '1': analysis ?? null },
      tailoredContentByProfileId,
    });
    persistRun(run);
    return runBatch(run);
  };

  const persistRun = (run: BatchRun) => {
    run.updatedAt = new Date().toISOString();
    if (!saveBatchRun(run)) {
      console.warn('The batch state could not be saved to browser storage; Resume will only work within this page session.');
    }
    setSavedRun({ ...run });
  };

  /**
   * Runs every build of the run that is not generated yet, in retry passes, marking each
   * one as it settles. Analyses are taken from the run when it already has them, so a
   * resumed run never pays twice for a job it already understood. Whatever is still not
   * generated when the passes end — stopped, parked after its attempts, or failed for a
   * reason a retry cannot fix — stays in the saved run for Resume.
   */
  const runBatch = async (run: BatchRun): Promise<BatchOutcome> => {
    // Whether an analysis was already on screen when the run started. The runner reports
    // every analysis it pays for; the builder only adopts them when it had none.
    const hadAnalysisAtStart = jobAnalysis !== null;
    try {
      const { outcome, successMessage, errorMessage, completed } = await runBatchModel(
        run,
        buildPort,
        {
          isCancelled: isStopRequested,
          persist: () => persistRun(run),
          onStep: setGenerationStep,
          onProgress: setGenerationProgress,
          onAnalysis: (analysis) => {
            if (!hadAnalysisAtStart) setJobAnalysis(analysis);
          },
        },
        {
          profiles,
          generationOptions: getDefaultGenerationOptions(),
          roleFromInput: shouldShowRoleInput,
        }
      );

      if (successMessage) setSuccessMessage(successMessage);
      if (errorMessage) setError(errorMessage);
      if (completed) {
        clearBatchRun();
        setSavedRun(null);
      }
      return outcome;
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const handleImportJobsFromSheets = async (
    importedJobs: ImportedSheetJob[],
    meta: { skippedRows: number }
  ) => {
    const selectedProfiles = getSelectedProfilesForSheetsBuilder();
    const fallbackRole = shouldShowRoleInput ? role.trim() : '';
    const normalizedJobs = importedJobs.map((job) => ({
      ...job,
      jobTitle: job.jobTitle.trim() || fallbackRole,
    }));
    const missingRoleRow = shouldShowRoleInput
      ? normalizedJobs.find((job) => !job.jobTitle.trim())
      : undefined;
    if (missingRoleRow) {
      throw new Error(
        `Row ${missingRoleRow.sourceRowNumber} has no job title. Map a job_title column or fill the Builder Role field as a fallback.`
      );
    }

    const run = createBatchRun({
      source: 'sheets',
      model: selectedModel,
      profiles: selectedProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
      jobs: normalizedJobs,
      skippedRows: meta.skippedRows,
      skipExisting: skipExistingBuilds,
    });
    persistRun(run);

    beginGeneration();
    setError('');
    setSuccessMessage('');
    resetGenerationOutputs();
    await runBatch(run);
  };

  /**
   * Reruns only the builds of the saved run that are not generated. By default with the
   * model selected now; an automatic resume after a reload passes the run's own model,
   * since the selector has just been reset to the default.
   */
  const handleResumeBatch = async (options: { model?: string } = {}) => {
    const run = savedRun ?? loadBatchRun();
    setAutoResumeIn(null);
    if (!run || isGenerating) return;
    if (profiles.length === 0) {
      setError('No enabled profiles are loaded; check Admin > Profiles, then resume.');
      return;
    }
    const requested = options.model && listModelOptions(modelSettings).some((option) => option.value === options.model) ? options.model : selectedModel;
    if (!requested) {
      setError('No AI provider is enabled. Enable one in Admin > Settings.');
      return;
    }
    if (requested !== selectedModel) setSelectedModel(requested);
    run.resumeCount += 1;
    run.model = requested;
    persistRun(run);

    beginGeneration();
    setError('');
    setSuccessMessage('');
    resetGenerationOutputs();
    await runBatch(run);
  };

  const handleDiscardBatch = () => {
    setAutoResumeIn(null);
    clearBatchRun();
    setSavedRun(null);
  };

  // Counts down to an automatic resume of an interrupted run, once profiles and settings are in.
  useEffect(() => {
    if (autoResumeIn === null || isLoadingData || isGenerating) return;
    if (autoResumeIn <= 0) {
      void handleResumeBatch({ model: savedRun?.model });
      return;
    }
    const timer = setTimeout(() => setAutoResumeIn((value) => (value === null ? null : value - 1)), 1000);
    return () => clearTimeout(timer);
    // handleResumeBatch and savedRun are read when the countdown ends; re-running the effect on their identity would restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResumeIn, isLoadingData, isGenerating]);

  const handleGenerate = async () => {
    if (!companyName.trim()) {
      setError('Please enter a company name');
      return;
    }
    if (shouldShowRoleInput && !role.trim()) {
      setError('Please enter a role');
      return;
    }
    if (jobDescription.trim().length < 50) {
      setError('Please provide a job description (minimum 50 characters)');
      return;
    }
    if (!selectedModel) {
      setError('No AI provider is enabled. Enable one in Admin > Settings.');
      return;
    }
    if (generateMode === 'single' && !selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (generateMode === 'multiple' && profiles.length === 0) {
      setError('No profiles available');
      return;
    }
    if (generateMode === 'multiple' && multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    beginGeneration();
    setError('');
    setSuccessMessage('');
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);

    try {
      setGenerationStep('Analyzing job description...');
      clearGenerationProgress();
      const analysis = await retryUntilSuccess(() => resumeApi.analyze(jobDescription, selectedModel), singleRetryHooks);
      setJobAnalysis(analysis);

      if (generateMode === 'single' && !autoGenerate) {
        setGenerationStep('Building preview...');
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        const preview = await retryUntilSuccess(() => resumeApi.preview({
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
          model: selectedModel,
          includeCoverLetter,
        }), singleRetryHooks);
        setPreviewHtml(preview.html);
        setPreviewTailored(preview.tailored);
        setIsSinglePreviewOpen(true);
        if (preview.tailoredContent) {
          setTailoredContent(preview.tailoredContent);
          setTailoredContentDraft(JSON.stringify(preview.tailoredContent, null, 2));
          setTailoredContentError('');
          setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent.unconfirmedHardSkills));
          setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent.unconfirmedSoftSkills));
        }
        setSuccessMessage('Preview generated. Review, edit manually if needed, then click Generate Resume to finalize.');
        return;
      }

      if (generateMode === 'multiple' && !autoGenerate) {
        const profileIds =
          multipleTarget === 'group'
            ? groups.find((group) => group.id === selectedGroupId)?.profileIds
            : undefined;
        if (multipleTarget === 'group' && !profileIds) {
          setError('Please select a group');
          return;
        }

        setGenerationStep('Building previews...');
        const res = await retryUntilSuccess(() => resumeApi.previewAll({
          jobDescription,
          jobAnalysis: analysis,
          model: selectedModel,
          profileIds,
          includeCoverLetter,
        }), singleRetryHooks);
        const previewsWithDrafts = res.previews.map((preview) => ({
          ...preview,
          draft: preview.tailoredContent
            ? JSON.stringify(preview.tailoredContent, null, 2)
            : '',
          error: '',
        }));
        setMultiplePreviews(previewsWithDrafts);
        setMultiplePreviewTailored(res.tailored);
        setMultiplePreviewIndex(0);
        const aggregated = aggregateUnconfirmedFromPreviews(previewsWithDrafts);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setSuccessMessage(`Preview generated for ${res.previews.length} profile(s). Review, then click Generate All to finalize.`);
        return;
      }


      if (generateMode === 'single') {
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
        setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
        const result = await retryUntilSuccess((pass) => resumeApi.generate({
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
          companyName: companyName.trim(),
          role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
          model: selectedModel,
          ...getDefaultGenerationOptions(),
          // A retry must never pay again for a build that finished before its reply was lost.
          skipExisting: pass > 1 ? true : undefined,
        }), singleRetryHooks);
        updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
        setSuccessMessage('Resume generated successfully.');
        setIsSinglePreviewOpen(false);
        setUnconfirmedHardSkills(toUnconfirmedItems(result.unconfirmedHardSkills));
        setUnconfirmedSoftSkills(toUnconfirmedItems(result.unconfirmedSoftSkills));
      } else {
        const targetProfiles = getSelectedProfilesForManualBuilder();
        const res = await generateSequentialResumes({
          targetProfiles,
          analysis,
          targetCompanyName: companyName.trim(),
          resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        });
        if (multipleTarget === 'group') {
          const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
          setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
        } else {
          setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
        }
        if (res.failed > 0) {
          setError(
            `${res.stopped ? `Stopped by you after ${res.passes} pass(es).` : 'Retried until only failures needing your action remained.'} ${res.failed} build(s) not finished. Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
          );
        }
        setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
        setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };


  const handleTailoredContentChange = (value: string) => {
    setTailoredContentDraft(value);
    if (!value.trim()) {
      setTailoredContent(null);
      setTailoredContentError('');
      return;
    }
    try {
      const parsed = JSON.parse(value) as TailoredContent;
      setTailoredContent(parsed);
      setTailoredContentError('');
    } catch {
      setTailoredContentError('Invalid JSON. Fix errors before generating.');
    }
  };

  const handleUnconfirmedSkillEdit = (
    type: 'hard' | 'soft',
    original: string,
    value: string
  ) => {
    const update = (items: UnconfirmedSkill[]) =>
      items.map((item) => (item.original === original ? { ...item, value } : item));
    if (type === 'hard') {
      setUnconfirmedHardSkills(update);
    } else {
      setUnconfirmedSoftSkills(update);
    }
  };

  const handleRemoveUnconfirmedSkill = (type: 'hard' | 'soft', skill: UnconfirmedSkill) => {
    const remove = (items: UnconfirmedSkill[]) =>
      items.filter((item) => item.original !== skill.original);
    if (type === 'hard') {
      setUnconfirmedHardSkills(remove);
    } else {
      setUnconfirmedSoftSkills(remove);
    }

    if (tailoredContent) {
      const normalizedOriginal = skill.original.trim().toLowerCase();
      const nextTailored: TailoredContent = {
        ...tailoredContent,
        unconfirmedHardSkills:
          type === 'hard'
            ? (tailoredContent.unconfirmedHardSkills ?? []).filter(
                (item) => item.trim().toLowerCase() !== normalizedOriginal
              )
            : tailoredContent.unconfirmedHardSkills,
        unconfirmedSoftSkills:
          type === 'soft'
            ? (tailoredContent.unconfirmedSoftSkills ?? []).filter(
                (item) => item.trim().toLowerCase() !== normalizedOriginal
              )
            : tailoredContent.unconfirmedSoftSkills,
      };
      setTailoredContent(nextTailored);
      const currentDraft = tailoredContentDraft.trim();
      if (currentDraft && currentDraft === JSON.stringify(tailoredContent, null, 2)) {
        setTailoredContentDraft(JSON.stringify(nextTailored, null, 2));
      }
    } else if (multiplePreviews.length > 0) {
      const normalizedOriginal = skill.original.trim().toLowerCase();
      const nextPreviews = multiplePreviews.map((item) => {
        if (!item.tailoredContent) return item;
        const nextTailored: TailoredContent = {
          ...item.tailoredContent,
          unconfirmedHardSkills:
            type === 'hard'
              ? (item.tailoredContent.unconfirmedHardSkills ?? []).filter(
                  (value) => value.trim().toLowerCase() !== normalizedOriginal
                )
              : item.tailoredContent.unconfirmedHardSkills,
          unconfirmedSoftSkills:
            type === 'soft'
              ? (item.tailoredContent.unconfirmedSoftSkills ?? []).filter(
                  (value) => value.trim().toLowerCase() !== normalizedOriginal
                )
              : item.tailoredContent.unconfirmedSoftSkills,
        };
        return {
          ...item,
          tailoredContent: nextTailored,
          draft: JSON.stringify(nextTailored, null, 2),
        };
      });
      setMultiplePreviews(nextPreviews);
      const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
    }
  };

  const handleConfirmSkill = async (type: 'hard' | 'soft', skill: UnconfirmedSkill) => {
    const cleaned = skill.value.trim();
    if (!cleaned) {
      setError('Skill cannot be empty');
      return;
    }

    try {
      beginGeneration();
      setError('');
      await resumeApi.confirmSkill({ type, skill: cleaned });

      const remove = (items: UnconfirmedSkill[]) =>
        items.filter((item) => item.original !== skill.original);

      if (type === 'hard') {
        setUnconfirmedHardSkills(remove);
      } else {
        setUnconfirmedSoftSkills(remove);
      }

      if (tailoredContent) {
        const normalizedOriginal = skill.original.trim().toLowerCase();
        const currentHard = tailoredContent.hardSkills ?? [];
        const currentSoft = tailoredContent.softSkills ?? [];
        const nextHard =
          type === 'hard'
            ? Array.from(
                new Set([
                  ...currentHard,
                  cleaned,
                ].map((item) => item.trim()).filter(Boolean))
              )
            : currentHard;
        const nextSoft =
          type === 'soft'
            ? Array.from(
                new Set([
                  ...currentSoft,
                  cleaned,
                ].map((item) => item.trim()).filter(Boolean))
              )
            : currentSoft;

        const nextTailored: TailoredContent = {
          ...tailoredContent,
          hardSkills: nextHard,
          softSkills: nextSoft,
          unconfirmedHardSkills:
            type === 'hard'
              ? (tailoredContent.unconfirmedHardSkills ?? []).filter(
                  (item) => item.trim().toLowerCase() !== normalizedOriginal
                )
              : tailoredContent.unconfirmedHardSkills,
          unconfirmedSoftSkills:
            type === 'soft'
              ? (tailoredContent.unconfirmedSoftSkills ?? []).filter(
                  (item) => item.trim().toLowerCase() !== normalizedOriginal
                )
              : tailoredContent.unconfirmedSoftSkills,
        };
        setTailoredContent(nextTailored);
        const currentDraft = tailoredContentDraft.trim();
        if (currentDraft && currentDraft === JSON.stringify(tailoredContent, null, 2)) {
          setTailoredContentDraft(JSON.stringify(nextTailored, null, 2));
        }
        if (selectedProfileId) {
          const profile = profiles.find((p) => p.id === selectedProfileId);
          const templateId = profile?.preferredTemplate || 'default';
          const refreshed = await resumeApi.preview({
            profileId: selectedProfileId!,
            templateId,
            jobDescription,
            jobAnalysis: jobAnalysis || undefined,
            tailoredContent: nextTailored,
            model: selectedModel,
          });
          setPreviewHtml(refreshed.html);
          setPreviewTailored(refreshed.tailored);
          setIsSinglePreviewOpen(true);
        }
      }

      if (!tailoredContent && multiplePreviews.length > 0) {
        const normalizedOriginal = skill.original.trim().toLowerCase();
        const updatedProfiles: Array<{ profileId: string; nextTailored: TailoredContent }> = [];
        let nextPreviews = multiplePreviews.map((item) => {
          if (!item.tailoredContent) return item;
          const unconfirmedHard = item.tailoredContent.unconfirmedHardSkills ?? [];
          const unconfirmedSoft = item.tailoredContent.unconfirmedSoftSkills ?? [];
          const hasMatch =
            (type === 'hard' && unconfirmedHard.some((value) => value.trim().toLowerCase() === normalizedOriginal)) ||
            (type === 'soft' && unconfirmedSoft.some((value) => value.trim().toLowerCase() === normalizedOriginal));
          if (!hasMatch) return item;

          const currentHard = item.tailoredContent.hardSkills ?? [];
          const currentSoft = item.tailoredContent.softSkills ?? [];
          const nextHard =
            type === 'hard'
              ? Array.from(
                  new Set(
                    [...currentHard, cleaned].map((value) => value.trim()).filter(Boolean)
                  )
                )
              : currentHard;
          const nextSoft =
            type === 'soft'
              ? Array.from(
                  new Set(
                    [...currentSoft, cleaned].map((value) => value.trim()).filter(Boolean)
                  )
                )
              : currentSoft;

          const nextTailored: TailoredContent = {
            ...item.tailoredContent,
            hardSkills: nextHard,
            softSkills: nextSoft,
            unconfirmedHardSkills:
              type === 'hard'
                ? unconfirmedHard.filter(
                    (value) => value.trim().toLowerCase() !== normalizedOriginal
                  )
                : unconfirmedHard,
            unconfirmedSoftSkills:
              type === 'soft'
                ? unconfirmedSoft.filter(
                    (value) => value.trim().toLowerCase() !== normalizedOriginal
                  )
                : unconfirmedSoft,
          };

          updatedProfiles.push({ profileId: item.profileId, nextTailored });

          return {
            ...item,
            tailoredContent: nextTailored,
            draft: JSON.stringify(nextTailored, null, 2),
            error: item.error,
          };
        });

        if (updatedProfiles.length > 0) {
          const refreshedList = await Promise.all(
            updatedProfiles.map(async ({ profileId, nextTailored }) => {
              const profile = profiles.find((p) => p.id === profileId);
              const templateId = profile?.preferredTemplate || 'default';
              const refreshed = await resumeApi.preview({
                profileId,
                templateId,
                jobDescription,
                jobAnalysis: jobAnalysis || undefined,
                tailoredContent: nextTailored,
                model: selectedModel,
              });
              return {
                profileId,
                html: refreshed.html,
                tailored: refreshed.tailored,
                tailoredContent: refreshed.tailoredContent ?? nextTailored,
              };
            })
          );
          if (refreshedList.some((item) => item.tailored)) {
            setMultiplePreviewTailored(true);
          }
          const refreshedMap = new Map(refreshedList.map((item) => [item.profileId, item]));
          nextPreviews = nextPreviews.map((item) => {
            const refreshed = refreshedMap.get(item.profileId);
            if (!refreshed) return item;
            return {
              ...item,
              html: refreshed.html,
              tailoredContent: refreshed.tailoredContent,
              draft: JSON.stringify(refreshed.tailoredContent, null, 2),
            };
          });
        }

        setMultiplePreviews(nextPreviews);
        const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
      }
      setSuccessMessage(`Added "${cleaned}" to ${type === 'hard' ? 'tech' : 'soft'} skills.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm skill');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleUpdatePreview = async () => {
    if (!selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    beginGeneration();
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep('Updating preview...');
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      const preview = await resumeApi.preview({
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent,
        model: selectedModel,
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
      setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedSoftSkills));
      setSuccessMessage('Preview updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerate = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50 || !selectedProfileId) {
      setError('Please complete the required fields before generating.');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before generating.');
      return;
    }

    beginGeneration();
    setError('');
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await retryUntilSuccess(() => resumeApi.analyze(jobDescription, selectedModel), singleRetryHooks));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
      setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
      const result = await retryUntilSuccess((pass) => resumeApi.generate({
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: analysis,
        tailoredContent: tailoredContent || undefined,
        companyName: companyName.trim(),
        role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        model: selectedModel,
        ...getDefaultGenerationOptions(),
        skipExisting: pass > 1 ? true : undefined,
      }), singleRetryHooks);
      updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
      setSuccessMessage('Resume generated successfully.');
      setIsSinglePreviewOpen(false);
      setUnconfirmedHardSkills(toUnconfirmedItems(result.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(result.unconfirmedSoftSkills));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const handleMultipleDraftChange = (profileId: string, value: string) => {
    setMultiplePreviews((prev) =>
      prev.map((preview) => {
        if (preview.profileId !== profileId) return preview;
        let nextError = '';
        let nextTailored = preview.tailoredContent;
        if (!value.trim()) {
          nextTailored = undefined;
        } else {
          try {
            nextTailored = JSON.parse(value) as TailoredContent;
          } catch {
            nextError = 'Invalid JSON. Fix errors before updating preview.';
          }
        }
        return {
          ...preview,
          draft: value,
          error: nextError,
          tailoredContent: nextTailored,
        };
      })
    );
  };

  const handleUpdateMultiplePreview = async (profileId: string) => {
    const preview = multiplePreviews.find((item) => item.profileId === profileId);
    if (!preview) return;
    if (preview.error) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!preview.tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    beginGeneration();
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep(`Updating preview for ${preview.profileName}...`);
      const profile = profiles.find((p) => p.id === profileId);
      const templateId = profile?.preferredTemplate || 'default';
      const updated = await resumeApi.preview({
        profileId,
        templateId,
        jobDescription,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent: preview.tailoredContent,
        model: selectedModel,
      });
      const nextPreviews = multiplePreviews.map((item) => {
        if (item.profileId !== profileId) return item;
        const nextTailored = updated.tailoredContent;
        return {
          ...item,
          html: updated.html,
          tailoredContent: nextTailored,
          draft: nextTailored ? JSON.stringify(nextTailored, null, 2) : '',
          error: '',
        };
      });
      setMultiplePreviews(nextPreviews);
      const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
      setSuccessMessage(`Preview updated for ${preview.profileName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerateMultiple = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50) {
      setError('Please complete the required fields before generating.');
      return;
    }

    if (multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    beginGeneration();
    setError('');
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await retryUntilSuccess(() => resumeApi.analyze(jobDescription, selectedModel), singleRetryHooks));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }

      if (!autoGenerate && multiplePreviews.length > 0) {
        const previewMap = new Map(multiplePreviews.map((p) => [p.profileId, p]));
        const targetProfiles =
          multipleTarget === 'group'
            ? profiles.filter((p) => p.id &&
                groups.find((g) => g.id === selectedGroupId)?.profileIds.includes(p.id))
            : profiles;
        const profilesToGenerate = targetProfiles.filter((profile) => previewMap.get(profile.id)?.tailoredContent);
        if (!profilesToGenerate.length) {
          throw new Error('No preview content available to generate.');
        }
        const res = await generateSequentialResumes({
          targetProfiles: profilesToGenerate,
          analysis,
          targetCompanyName: companyName.trim(),
          resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
          tailoredContentByProfileId: new Map(profilesToGenerate.map((profile) => [profile.id, previewMap.get(profile.id)?.tailoredContent])),
        });
        setSuccessMessage(`Generated ${res.generated} of ${profilesToGenerate.length} resume(s).`);
        if (res.failed > 0) {
          setError(
            `${res.stopped ? `Stopped by you after ${res.passes} pass(es).` : 'Retried until only failures needing your action remained.'} ${res.failed} build(s) not finished. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
          );
        }
        const aggregated = aggregateUnconfirmedFromPreviews(multiplePreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setMultiplePreviews([]);
        setMultiplePreviewIndex(0);
        setMultiplePreviewTailored(false);
        return;
      }

      const targetProfiles = getSelectedProfilesForManualBuilder();
      const res = await generateSequentialResumes({
        targetProfiles,
        analysis,
        targetCompanyName: companyName.trim(),
        resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
      });
      if (multipleTarget === 'group') {
        const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
        setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
      } else {
        setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
      }
      if (res.failed > 0) {
        setError(
          `${res.stopped ? `Stopped by you after ${res.passes} pass(es).` : 'Retried until only failures needing your action remained.'} ${res.failed} build(s) not finished. Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
        );
      }
      setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const activeMultiplePreview = multiplePreviews[multiplePreviewIndex];

  // Shared by both builder modes: the letter is the largest slice of output tokens in a
  // run, so turning it off is the one control that visibly changes what a batch costs.
  const coverLetterToggle = (
    <SwitchRow
      title="Cover letter"
      description={
        includeCoverLetter
          ? 'A letter is written and saved with every resume.'
          : 'Resumes only — skips the letter and the tokens it costs.'
      }
      checked={includeCoverLetter}
      onChange={setIncludeCoverLetter}
      disabled={isGenerating}
    />
  );

  const savedRunSummary = savedRun ? summarizeBatchRun(savedRun) : null;
  const selectedModelLabel = listModelOptions(modelSettings).find((option) => option.value === selectedModel)?.label ?? selectedModel;

  const skipExistingToggle = (
    <SwitchRow
      title="Skip builds already on disk"
      description={
        skipExistingBuilds
          ? 'A job whose files already exist is skipped, so an interrupted run can be restarted and resumes where it stopped.'
          : 'Every job is generated again, overwriting files that already exist.'
      }
      checked={skipExistingBuilds}
      onChange={setSkipExistingBuilds}
      disabled={isGenerating}
    />
  );

  const unconfirmedPanel = (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="text-sm font-medium text-gray-700">Unregistered Skills</div>
      {unconfirmedHardSkills.length === 0 && unconfirmedSoftSkills.length === 0 && (
        <div className="text-xs text-gray-500">No unregistered skills found.</div>
      )}
      {unconfirmedHardSkills.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">Tech Skills</div>
          <div className="grid grid-cols-2 gap-2">
            {unconfirmedHardSkills.map((skill) => (
              <div key={`uh-${skill.original}`} className="flex items-center gap-2">
                <input
                  type="text"
                  value={skill.value}
                  onChange={(e) =>
                    handleUnconfirmedSkillEdit('hard', skill.original, e.target.value)
                  }
                  disabled={isGenerating}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleConfirmSkill('hard', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveUnconfirmedSkill('hard', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:text-gray-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {unconfirmedSoftSkills.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">Soft Skills</div>
          <div className="grid grid-cols-2 gap-2">
            {unconfirmedSoftSkills.map((skill) => (
              <div key={`us-${skill.original}`} className="flex items-center gap-2">
                <input
                  type="text"
                  value={skill.value}
                  onChange={(e) =>
                    handleUnconfirmedSkillEdit('soft', skill.original, e.target.value)
                  }
                  disabled={isGenerating}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleConfirmSkill('soft', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveUnconfirmedSkill('soft', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:text-gray-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (isLoadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AppTopNav />

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Generate Resumes</h1>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-700 hover:text-red-900 font-bold">
              ×
            </button>
          </div>
        )}

        {successMessage && (
          <div className="mb-6 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
            {successMessage}
          </div>
        )}

        {process.env.NODE_ENV === 'development' && (
          <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
            Development server: saving any project file reloads this page and interrupts a run in progress (the run is saved
            and offers to resume). For a long batch run the built app: <code>npm run build</code> then <code>npm start</code> in
            backend and frontend.
          </div>
        )}

        {savedRun && savedRunSummary && savedRunSummary.remaining > 0 && (
          <div className="mb-6 space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-medium">
              {wasInterrupted(savedRun) ? 'Interrupted' : 'Unfinished'} run from {new Date(savedRun.startedAt).toLocaleString()} ({describeRunSource(savedRun)}):{' '}
              {savedRunSummary.generated + savedRunSummary.skipped} of {savedRunSummary.total} builds done
            </div>
            <div>
              {savedRunSummary.remaining} build(s) across {savedRunSummary.jobsRemaining} job(s) are not generated
              {savedRunSummary.failed > 0 ? ` (${savedRunSummary.failed} failed, ${savedRunSummary.pending} never started)` : ''}.
              Resume runs only those with the model selected in the builder ({selectedModelLabel}), reuses the analyses already paid for, and skips files already on disk.
              {savedRun.model !== selectedModel ? ` The run was started with ${savedRun.model}.` : ''}
            </div>
            {autoResumeIn !== null && !isGenerating && (
              <div className="font-medium">
                This run was interrupted (the page was reloaded or closed). Resuming automatically in {autoResumeIn} s with {savedRun.model}.{' '}
                <button type="button" onClick={() => setAutoResumeIn(null)} className="underline hover:text-amber-950">
                  Cancel
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleResumeBatch()}
                disabled={isGenerating}
                className="rounded-md bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-60"
              >
                Resume {savedRunSummary.remaining} build(s)
              </button>
              <button
                type="button"
                onClick={handleDiscardBatch}
                disabled={isGenerating}
                className="rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {isGenerating && generationProgress && (
          <GenerationProgress progress={generationProgress} className="mb-6" />
        )}

        {builderMode === null && (
          <div className="mb-6 grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setBuilderMode('manual')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'manual'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Manually</div>
            <div className="mt-2 text-sm text-gray-600">
              Original builder flow. Enter company, role, and job description manually, then preview or generate.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setBuilderMode('sheets')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'sheets'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Automatically from Google Sheet</div>
            <div className="mt-2 text-sm text-gray-600">
              Import jobs from Google Sheets, map columns once, then generate every selected profile against every imported row.
            </div>
          </button>
          </div>
        )}

        {builderMode !== null && (builderMode === 'manual' ? (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></span>
                  {generationStep || 'Generating...'}
                </>
              ) : (
                generateMode === 'single'
                  ? autoGenerate
                    ? 'Generate Resume'
                    : 'Analyze & Preview'
                  : autoGenerate
                    ? `Generate All (${profiles.length} profiles)`
                    : 'Analyze & Preview'
              )}
            </button>
            {isGenerating && (
              <button
                type="button"
                onClick={requestStop}
                className="w-full rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Stop after the current build
              </button>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Generate mode
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="single"
                    checked={generateMode === 'single'}
                    onChange={() => setGenerateMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single (one profile)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="multiple"
                    checked={generateMode === 'multiple'}
                    onChange={() => setGenerateMode('multiple')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Multiple (all profiles)</span>
                </label>
              </div>
            </div>

            {generateMode === 'single' && (
              <ProfileSelector
                profiles={profiles}
                selectedId={selectedProfileId}
                onChange={setSelectedProfileId}
                isLoading={false}
              />
            )}

            {generateMode === 'multiple' && (
              <div className="space-y-4 border border-gray-200 rounded-lg p-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Target</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="all"
                        checked={multipleTarget === 'all'}
                        onChange={() => setMultipleTarget('all')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>All profiles</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="group"
                        checked={multipleTarget === 'group'}
                        onChange={() => setMultipleTarget('group')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>Specific group</span>
                    </label>
                  </div>
                </div>

                {multipleTarget === 'group' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                    <select
                      value={selectedGroupId}
                      onChange={(e) => setSelectedGroupId(e.target.value)}
                      disabled={isGenerating}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Choose a group...</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} ({group.profileIds.length})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Company Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={isGenerating}
                placeholder="Enter company name"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Role <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Enter job role/title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Job Description <span className="text-red-500">*</span>
              </label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                disabled={isGenerating}
                placeholder="Paste the job description (min 50 characters)"
                rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <p className="text-sm text-gray-500 mt-1">{jobDescription.length} characters</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">AI Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isGenerating}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {listModelOptions(modelSettings).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div
              className={`flex items-center justify-between border rounded-lg p-4 transition-colors ${
                autoGenerate ? 'border-blue-200 bg-blue-50' : 'border-red-200 bg-red-50'
              }`}
            >
              <div>
                <div className="text-sm font-semibold text-gray-800">
                  {autoGenerate ? 'Auto-generate (On)' : 'Preview mode (On)'}
                </div>
                <div className="text-xs text-gray-600">
                  {autoGenerate
                    ? 'Analyze + generate in one step.'
                    : 'Analyze + preview first. Generate manually.'}
                </div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenerate}
                  onChange={(e) => setAutoGenerate(e.target.checked)}
                  disabled={isGenerating}
                  className="sr-only"
                />
                <span
                  className={`relative w-11 h-6 rounded-full peer-focus:outline-none transition-colors ${
                    autoGenerate ? 'bg-blue-600' : 'bg-red-500'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 bg-white rounded-full transition-transform ${
                      autoGenerate ? 'translate-x-5' : ''
                    }`}
                  />
                </span>
              </label>
            </div>

            {coverLetterToggle}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              Import a Google Sheet range where each row is one job. After column mapping, the builder will generate every selected profile against every imported row.
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Build target
              </label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="single"
                    checked={sheetsTargetMode === 'single'}
                    onChange={() => setSheetsTargetMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single profile</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="all"
                    checked={sheetsTargetMode === 'all'}
                    onChange={() => setSheetsTargetMode('all')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>All profiles</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="group"
                    checked={sheetsTargetMode === 'group'}
                    onChange={() => setSheetsTargetMode('group')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Specific group</span>
                </label>
              </div>
            </div>

            {sheetsTargetMode === 'single' && (
              <ProfileSelector
                profiles={profiles}
                selectedId={selectedSheetsProfileId}
                onChange={setSelectedSheetsProfileId}
                isLoading={false}
              />
            )}

            {sheetsTargetMode === 'group' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                <select
                  value={selectedSheetsGroupId}
                  onChange={(e) => setSelectedSheetsGroupId(e.target.value)}
                  disabled={isGenerating}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Choose a group...</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.profileIds.length})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Fallback Role
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Optional fallback if a sheet row has no mapped job title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Leave this blank if your imported rows already include a mapped job title column.
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">AI Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isGenerating}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {listModelOptions(modelSettings).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            {coverLetterToggle}

            {skipExistingToggle}

            {!hasGoogleSheetSources && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Save at least one Google Sheet in the Admin Google Sheets panel before importing jobs here.
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                if (!hasGoogleSheetSources) {
                  setError('Save at least one Google Sheet in the Admin Google Sheets panel before importing.');
                  return;
                }
                setError('');
                setIsSheetsImportOpen(true);
              }}
              disabled={isGenerating}
              className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
            >
              {isGenerating ? generationStep || 'Generating...' : 'Import from Google Sheet'}
            </button>
            {isGenerating && (
              <button
                type="button"
                onClick={requestStop}
                className="w-full rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Stop after the current build
              </button>
            )}
          </div>
        ))}

        {builderMode === 'manual' && generateMode === 'multiple' && autoGenerate && unconfirmedPanel && (
          <div className="mt-6">{unconfirmedPanel}</div>
        )}

        {builderMode === 'manual' && generateMode === 'multiple' && !autoGenerate && multiplePreviews.length > 0 && activeMultiplePreview && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
            <div className="absolute inset-4 bg-white rounded-xl shadow-2xl flex flex-col">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900">Resume Preview</h3>
                  <span className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                    {multiplePreviewIndex + 1} / {multiplePreviews.length}
                  </span>
                  {multiplePreviewTailored && (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                      ATS OPTIMIZATION
                    </span>
                  )}
                  <span className="text-sm text-gray-600">{activeMultiplePreview.profileName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.max(0, i - 1))}
                    disabled={multiplePreviewIndex === 0 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.min(multiplePreviews.length - 1, i + 1))}
                    disabled={multiplePreviewIndex >= multiplePreviews.length - 1 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Next
                  </button>
                  <button
                    onClick={handleFinalizeGenerateMultiple}
                    disabled={isGenerating}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed font-medium transition-colors"
                  >
                    {isGenerating ? generationStep || 'Generating...' : 'Generate All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMultiplePreviews([]);
                      setMultiplePreviewIndex(0);
                    }}
                    disabled={isGenerating}
                    className="px-3 py-2 text-sm bg-white text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="flex-1 grid grid-cols-2 overflow-hidden">
                <div className="h-full overflow-y-auto bg-gray-100 p-6">
                  {isGenerating && generationProgress && (
                    <GenerationProgress progress={generationProgress} className="mb-4" />
                  )}
                  <div className="resume-paper-shell bg-white shadow-lg mx-auto max-w-[816px]">
                    <iframe
                      srcDoc={activeMultiplePreview.html} sandbox=""
                      className="w-full h-[1056px] border-0"
                      title={`Resume Preview - ${activeMultiplePreview.profileName}`}
                    />
                  </div>
                </div>
                <div className="h-full overflow-y-auto border-l p-6 space-y-6">
                  {unconfirmedPanel}

                  <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                    <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                    <textarea
                      value={activeMultiplePreview.draft}
                      onChange={(e) => handleMultipleDraftChange(activeMultiplePreview.profileId, e.target.value)}
                      rows={8}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Edit tailored content JSON here."
                    />
                    {activeMultiplePreview.error && (
                      <p className="text-sm text-red-600 mt-2">{activeMultiplePreview.error}</p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleUpdateMultiplePreview(activeMultiplePreview.profileId)}
                        disabled={isGenerating || !!activeMultiplePreview.error}
                        className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                      >
                        Update Preview
                      </button>
                      <span className="text-xs text-gray-500">
                        Apply edits to preview before final generate.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && (
          <ResumePreview
            html={previewHtml}
            onGenerate={handleFinalizeGenerate}
            isGenerating={isGenerating}
            isTailored={previewTailored}
            isOpen={isSinglePreviewOpen}
            onClose={() => setIsSinglePreviewOpen(false)}
            generationStep={generationStep}
            generationProgress={generationProgress}
            sidebar={
              <>
                {unconfirmedPanel}
                <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                  <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                  <textarea
                    value={tailoredContentDraft}
                    onChange={(e) => handleTailoredContentChange(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Edit tailored content JSON here."
                  />
                  {tailoredContentError && (
                    <p className="text-sm text-red-600 mt-2">{tailoredContentError}</p>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleUpdatePreview}
                      disabled={isGenerating || !!tailoredContentError}
                      className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                    >
                      Update Preview
                    </button>
                    <span className="text-xs text-gray-500">
                      Apply edits to preview before final generate.
                    </span>
                  </div>
                </div>
              </>
            }
          />
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && !isSinglePreviewOpen && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setIsSinglePreviewOpen(true)}
              className="px-3 py-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Open Preview
            </button>
          </div>
        )}
      </main>

      <SheetsImportModal
        isOpen={isSheetsImportOpen}
        isSubmitting={isGenerating}
        showJobTitleMapping={shouldShowRoleInput}
        sources={modelSettings.googleSheetsSources}
        selectedSourceId={selectedSheetsSourceId}
        onSelectSource={setSelectedSheetsSourceId}
        onClose={() => setIsSheetsImportOpen(false)}
        onConfirm={handleImportJobsFromSheets}
      />

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-gray-500">
        <p>Tailored Resume Builder - Powered by OpenAI, Anthropic, and OpenRouter</p>
      </footer>
    </div>
  );
}
