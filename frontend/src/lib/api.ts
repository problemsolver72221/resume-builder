const DEFAULT_LOCAL_API_BASE = 'http://localhost:3001/api';
// Empty unless someone set it for this instance. `npm run dev` at the project root sets it
// to the port that copy's backend actually bound.
const EXPLICIT_API_BASE = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
const CONFIGURED_FALLBACK_API_BASE = (process.env.NEXT_PUBLIC_FALLBACK_API_URL || '').replace(/\/$/, '');
/** Ports are handed out in pairs: frontend 3000 with backend 3001, 3002 with 3003. */
const BACKEND_PORT_OFFSET = 1;
let resolvedApiBase: string | null = null;

/**
 * The backend that belongs to the page being viewed, worked out from the port the page was
 * served on. Without this, every copy of the project falls back to the same hardcoded port
 * and they all talk to whichever copy happens to own it — so a build started in the copy on
 * 3002 would land in the data folder of the copy on 3000.
 */
function getPairedApiBase(): string | null {
  if (typeof window === 'undefined') return null;
  const port = Number(window.location.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  return `${window.location.protocol}//${window.location.hostname}:${port + BACKEND_PORT_OFFSET}/api`;
}

/** An explicit setting always wins; otherwise the paired port, and only then the default. */
function getConfiguredApiBase(): string {
  return EXPLICIT_API_BASE || getPairedApiBase() || DEFAULT_LOCAL_API_BASE;
}

/** The configured base served from whatever host the page itself came from, for LAN access. */
function getBrowserMatchedApiBase(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const configuredUrl = new URL(getConfiguredApiBase());
    configuredUrl.hostname = window.location.hostname;
    return configuredUrl.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function buildApiBaseCandidates(): string[] {
  const configured = getConfiguredApiBase();
  const browserMatchedApiBase = getBrowserMatchedApiBase();
  const candidates = [resolvedApiBase ?? configured];

  if (browserMatchedApiBase) {
    candidates.push(browserMatchedApiBase);
  }

  candidates.push(configured);

  if (CONFIGURED_FALLBACK_API_BASE) {
    candidates.push(CONFIGURED_FALLBACK_API_BASE);
  }
  return [...new Set(candidates)];
}

function getCurrentApiBase(): string {
  return resolvedApiBase ?? getConfiguredApiBase();
}
export function getApiOrigin(): string {
  return getCurrentApiBase().replace(/\/api$/, '');
}

// Auth helpers
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem('adminToken');
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem('adminToken', token);
  } catch {
    // Ignore storage errors (private mode / blocked storage)
  }
}

export function removeToken(): void {
  try {
    localStorage.removeItem('adminToken');
  } catch {
    // Ignore storage errors
  }
}

function getAuthHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** A failed request. `retryable` says whether sending the same request again can succeed. */
export class ApiError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  /**
   * The backend's "not now, later": a model too slow for this request at the moment, a
   * model that declined once. The backend does not re-send those within a call, but the
   * builders' retry passes, with their minutes-long waits, are exactly the later it means.
   */
  readonly retryLater: boolean;

  constructor(message: string, status?: number, retryable?: boolean, retryLater = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // The backend states it for AI failures. Otherwise a connection or server-side problem
    // is worth another try and a rejected request (4xx) is not.
    this.retryable = retryable ?? (status === undefined || status >= 500 || status === 408 || status === 409 || status === 429);
    this.retryLater = retryLater;
  }
}

/** RequestInit plus a client-side deadline: a request the backend never answers must not hold a batch forever. */
type ApiRequestOptions = RequestInit & { timeoutMs?: number };

/** A build can legitimately take minutes (AI retries, PDF rendering); anything past this is abandoned and retried. */
export const BUILD_REQUEST_TIMEOUT_MS = 32 * 60_000;
export const ANALYSIS_REQUEST_TIMEOUT_MS = 15 * 60_000;
export const QUICK_REQUEST_TIMEOUT_MS = 60_000;

// Generic fetch wrapper
async function apiFetch<T>(
  endpoint: string,
  { timeoutMs, ...options }: ApiRequestOptions = {}
): Promise<T> {
  const headers: HeadersInit = {
    ...getAuthHeaders(),
    ...options.headers,
  };
  const controller = timeoutMs ? new AbortController() : undefined;
  const deadline = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  // Don't set Content-Type for FormData
  if (!(options.body instanceof FormData)) {
    (headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  let lastConnectionError: Error | null = null;

  for (const apiBase of buildApiBaseCandidates()) {
    const url = `${apiBase}${endpoint}`;

    // fetch() itself rejects only when the request never got an answer (DNS, refused,
    // offline, CORS); that is the only case worth trying the next base URL for. An HTTP
    // error resolves normally and is final — matching on the word "fetch" in a message
    // used to mistake server errors such as "Failed to fetch profiles" for outages and
    // re-send non-idempotent requests.
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        signal: controller?.signal ?? options.signal,
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        clearTimeout(deadline);
        // The request reached the backend and was never answered; trying the next base URL
        // would only start the same build a second time.
        throw new ApiError(
          `No answer from the backend after ${Math.round((timeoutMs ?? 0) / 60_000)} minutes; the build is retried later`,
          undefined,
          true
        );
      }
      lastConnectionError = error instanceof Error ? error : new Error(String(error));
      continue;
    }

    if (!response.ok) {
      clearTimeout(deadline);
      const body = (await response.json().catch(() => ({}))) as { error?: unknown; retryable?: unknown; retryLater?: unknown };
      throw new ApiError(
        typeof body.error === 'string' && body.error ? body.error : `Request failed (${response.status})`,
        response.status,
        typeof body.retryable === 'boolean' ? body.retryable : undefined,
        body.retryLater === true
      );
    }

    resolvedApiBase = apiBase;
    try {
      return await response.json();
    } finally {
      clearTimeout(deadline);
    }
  }

  clearTimeout(deadline);
  throw new ApiError(
    lastConnectionError ? `Unable to connect to backend (${lastConnectionError.message})` : 'Unable to connect to backend',
    undefined,
    true
  );
}

/** Provider id as defined by the backend registry (backend/src/providers/registry.ts). */
export type AIProvider = string;

/** What the builder sends as `model`: "<providerId>/<model>" for one of a provider's listed models, or a bare provider id for its default. */
export type ModelChoice = string;

export interface ProviderInfo {
  id: AIProvider;
  label: string;
  /** The provider's default model — the first of `models`. */
  model: string;
  /** Every model the backend lists for this provider. */
  models: string[];
  enabled: boolean;
  /** True when the backend holds a usable API key (stored or environment) for this provider. */
  configured: boolean;
}
export type DefaultMode = 'preview' | 'generate';
export type ThemeMode = 'light' | 'dark';
export type DefaultResumeSelection = 'single' | 'all' | 'group';

export interface GoogleSheetSource {
  id: string;
  name: string;
  sheetId: string;
  createdAt: string;
  updatedAt: string;
}

// Admin API
export interface PublicAppSettings {
  providers: ProviderInfo[];
  /** Admin-chosen default provider; '' lets the builder pick the first usable one. */
  defaultProviderId: AIProvider;
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  defaultResumeSelection: DefaultResumeSelection;
  defaultGroupId: string;
  defaultProfileId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  /** When false the builder skips the cover letter entirely — no AI call, no files. */
  defaultCoverLetterEnabled: boolean;
  outputPathUsesJobTitle: boolean;
  googleSheetsSources: GoogleSheetSource[];
}

export type AIModelSettings = PublicAppSettings;

export interface AdminApiKeyEntry {
  id: string;
  name: string;
  preview: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface AdminApiKeyProviderSettings {
  configured: boolean;
  activeSource: 'stored' | 'environment' | 'none';
  activeKeyId: string | null;
  activePreview: string | null;
  environmentPreview: string | null;
  entries: AdminApiKeyEntry[];
}

export interface AdminAppSettings extends PublicAppSettings {
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
  apiKeys: Record<AIProvider, AdminApiKeyProviderSettings>;
}

function normalizeGoogleSheetSources(value: unknown): GoogleSheetSource[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is GoogleSheetSource => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      sheetId: typeof entry.sheetId === 'string' ? entry.sheetId : '',
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    }))
    .filter((entry) => entry.id && entry.name && entry.sheetId);
}

function normalizeProviders(value: unknown): ProviderInfo[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const id = typeof entry.id === 'string' ? entry.id : '';
      const model = typeof entry.model === 'string' ? entry.model : '';
      const listed = Array.isArray(entry.models)
        ? entry.models.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
      return {
        id,
        label: typeof entry.label === 'string' && entry.label ? entry.label : id,
        model,
        models: listed.length > 0 ? listed : model ? [model] : [],
        enabled: entry.enabled === true,
        configured: entry.configured === true,
      };
    })
    .filter((entry) => entry.id);
}

function normalizePublicAppSettings(value: unknown): PublicAppSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<PublicAppSettings>;

  return {
    providers: normalizeProviders(source.providers),
    defaultProviderId: typeof source.defaultProviderId === 'string' ? source.defaultProviderId : '',
    defaultMode: source.defaultMode === 'generate' ? 'generate' : 'preview',
    defaultTheme: source.defaultTheme === 'dark' ? 'dark' : 'light',
    defaultResumeSelection:
      source.defaultResumeSelection === 'all' || source.defaultResumeSelection === 'group'
        ? source.defaultResumeSelection
        : 'single',
    defaultGroupId: typeof source.defaultGroupId === 'string' ? source.defaultGroupId : '',
    defaultProfileId: typeof source.defaultProfileId === 'string' ? source.defaultProfileId : '',
    defaultResumeDocxEnabled:
      typeof source.defaultResumeDocxEnabled === 'boolean' ? source.defaultResumeDocxEnabled : true,
    defaultCoverLetterDocxEnabled:
      typeof source.defaultCoverLetterDocxEnabled === 'boolean' ? source.defaultCoverLetterDocxEnabled : true,
    defaultCoverLetterEnabled:
      typeof source.defaultCoverLetterEnabled === 'boolean' ? source.defaultCoverLetterEnabled : true,
    outputPathUsesJobTitle:
      typeof source.outputPathUsesJobTitle === 'boolean' ? source.outputPathUsesJobTitle : true,
    googleSheetsSources: normalizeGoogleSheetSources(source.googleSheetsSources),
  };
}

function normalizeAdminAppSettings(value: unknown): AdminAppSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Partial<AdminAppSettings>;

  return {
    ...normalizePublicAppSettings(source),
    outputBaseDir: typeof source.outputBaseDir === 'string' ? source.outputBaseDir : '',
    outputPathTemplate: typeof source.outputPathTemplate === 'string' ? source.outputPathTemplate : '',
    outputPathPreview: typeof source.outputPathPreview === 'string' ? source.outputPathPreview : '',
    apiKeys:
      typeof source.apiKeys === 'object' && source.apiKeys !== null
        ? (source.apiKeys as Record<AIProvider, AdminApiKeyProviderSettings>)
        : {},
  };
}

export interface ApiKeyProviderUpdate {
  activeKeyId?: string;
  add?: Array<{
    clientId?: string;
    name?: string;
    value: string;
  }>;
  removeIds?: string[];
  useEnvironmentFallback?: boolean;
}

export interface AdminAppSettingsUpdate extends Partial<Omit<PublicAppSettings, 'providers'>> {
  /** Per-provider enabled flags; ids left out keep their stored value. */
  enabledProviders?: Record<AIProvider, boolean>;
  outputBaseDir?: string;
  outputPathTemplate?: string;
  apiKeys?: Partial<Record<AIProvider, ApiKeyProviderUpdate | string>>;
}

export interface BrowseOutputDirectoryResponse {
  selectedPath: string | null;
}

export interface GoogleSheetTab {
  title: string;
  index: number;
  sheetId: number;
}

export interface GoogleSheetColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface GoogleSheetBorder {
  style: string;
  color: GoogleSheetColor;
}

export interface GoogleSheetTextFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontSize: number | null;
  fontFamily: string | null;
  foregroundColor: GoogleSheetColor | null;
}

export interface GoogleSheetCellFormat {
  backgroundColor: GoogleSheetColor | null;
  textFormat: GoogleSheetTextFormat | null;
  horizontalAlignment: string | null;
  verticalAlignment: string | null;
  wrapStrategy: string | null;
  borders: {
    top: GoogleSheetBorder | null;
    right: GoogleSheetBorder | null;
    bottom: GoogleSheetBorder | null;
    left: GoogleSheetBorder | null;
  };
}

export interface GoogleSheetCell {
  value: string;
  format: GoogleSheetCellFormat | null;
}

export interface GoogleSheetMergeRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface GoogleSheetsRangeRequest {
  sheetId: string;
  tabName?: string;
  fromRow?: number;
  toRow?: number;
  fromCol?: number;
  toCol?: number;
}

export interface GoogleSheetsUpdateRangeRequest extends GoogleSheetsRangeRequest {
  values: string[][];
}

export interface GoogleSheetsRangeResponse {
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabs: GoogleSheetTab[];
  selectedTab?: string;
  range?: {
    fromRow: number;
    toRow: number;
    fromCol: number;
    toCol: number;
    a1Notation: string;
  };
  cells?: GoogleSheetCell[][];
  rowHeights?: number[];
  columnWidths?: number[];
  merges?: GoogleSheetMergeRange[];
  values?: string[][];
  totalRows?: number;
  totalColumns?: number;
}

export interface GoogleSheetsUpdateRangeResponse {
  spreadsheetId: string;
  spreadsheetTitle: string;
  selectedTab: string;
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
}

export const adminApi = {
  login: (password: string) =>
    apiFetch<{ token: string; message: string }>('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () =>
    apiFetch<{ message: string }>('/admin/logout', {
      method: 'POST',
    }),

  verify: () =>
    apiFetch<{ valid: boolean }>('/admin/verify'),

  getSettings: async () =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/settings')),

  browseOutputDirectory: (currentPath?: string) =>
    apiFetch<BrowseOutputDirectoryResponse>('/admin/browse-output-directory', {
      method: 'POST',
      body: JSON.stringify({ currentPath }),
    }),

  fetchGoogleSheetRange: (data: GoogleSheetsRangeRequest) =>
    apiFetch<GoogleSheetsRangeResponse>('/admin/google-sheets/range', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateGoogleSheetRange: (data: GoogleSheetsUpdateRangeRequest) =>
    apiFetch<GoogleSheetsUpdateRangeResponse>('/admin/google-sheets/range', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateSettings: async (data: AdminAppSettingsUpdate) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    })),

  getAIModels: async () =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/ai-models')),

  updateAIModels: async (data: AdminAppSettingsUpdate) =>
    normalizeAdminAppSettings(await apiFetch<AdminAppSettings>('/admin/ai-models', {
      method: 'PUT',
      body: JSON.stringify(data),
    })),
};

export const importApi = {
  fetchGoogleSheetRange: (data: GoogleSheetsRangeRequest) =>
    apiFetch<GoogleSheetsRangeResponse>('/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Profile, job-analysis, resume and template shapes are declared once in shared/types and
// re-exported here, so every `from '@/lib/api'` import keeps working and neither half can
// drift from the other. See shared/README.md. They are imported as well as re-exported
// because a bare `export ... from` does not bind the names for this module's own use.
import type {
  Certification,
  Contact,
  CreateProfileDTO,
  Education,
  Experience,
  Group,
  Profile,
  Strength,
} from '@shared/types/profile';

export type {
  Certification,
  Contact,
  CreateProfileDTO,
  Education,
  Experience,
  Group,
  Profile,
  Strength,
};

import type {
  CreateTemplateDTO,
  ManualTemplateConfigStored,
  ManualTemplateStyle,
  Template,
} from '@shared/types/template';

export type { CreateTemplateDTO, ManualTemplateConfigStored, ManualTemplateStyle, Template };

export type PromptResponseFormat = 'json' | 'text';

export interface PromptVariableDefinition {
  name: string;
  description?: string;
  sampleValue?: string;
}

export interface PromptValidation {
  usedVariables: string[];
  unknownVariables: string[];
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  responseFormat: PromptResponseFormat;
  allowedVariables: PromptVariableDefinition[];
  validation: PromptValidation;
  isBuiltIn: boolean;
  usage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptRecord extends PromptSummary {
  content: string;
}

export interface PromptPreviewResult {
  renderedContent: string;
  sampleValues: Record<string, string>;
  validation: PromptValidation;
}

import type {
  AcronymPair,
  JobAnalysis,
  JobKeywords,
  JobMeta,
  JobSkills,
} from '@shared/types/jobAnalysis';
import type {
  ResumeFormat,
  SectionLabels,
  TailoredContentBase,
  TailoredExperience,
  TailoredStrength,
} from '@shared/types/resume';

export type {
  AcronymPair,
  JobAnalysis,
  JobKeywords,
  JobMeta,
  JobSkills,
  ResumeFormat,
  SectionLabels,
  TailoredExperience,
  TailoredStrength,
};

/**
 * What this side works with. The backend's own TailoredContent adds the cover-letter style
 * and seed, which the renderers consume server-side and nothing here reads.
 *
 * The unconfirmed-skill lists are optional here and required there on purpose: the backend
 * always fills them, but this side also parses content out of the preview editor's textarea
 * and out of batch runs saved before the fields existed, where they can be missing.
 */
export type TailoredContent = Omit<
  TailoredContentBase,
  'unconfirmedHardSkills' | 'unconfirmedSoftSkills'
> & {
  unconfirmedHardSkills?: string[];
  unconfirmedSoftSkills?: string[];
};

// Profiles API
export const profilesApi = {
  getAll: (options?: { includeDisabled?: boolean }) =>
    apiFetch<Profile[]>(
      options?.includeDisabled ? '/profiles?includeDisabled=true' : '/profiles'
    ),

  getById: (id: string) => apiFetch<Profile>(`/profiles/${id}`),

  create: (data: CreateProfileDTO) =>
    apiFetch<Profile>('/profiles', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<CreateProfileDTO>) =>
    apiFetch<Profile>(`/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/profiles/${id}`, {
      method: 'DELETE',
    }),

  uploadResume: (file: File) => {
    const formData = new FormData();
    formData.append('resume', file);
    return apiFetch<Profile>('/profiles/upload', {
      method: 'POST',
      body: formData,
    });
  },
};

// Groups API
export const groupsApi = {
  getAll: () => apiFetch<Group[]>('/groups'),

  create: (data: { name: string; profileIds: string[] }) =>
    apiFetch<Group>('/groups', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { name?: string; profileIds?: string[] }) =>
    apiFetch<Group>(`/groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/groups/${id}`, {
      method: 'DELETE',
    }),
};

// Templates API
export const templatesApi = {
  getAll: (options?: { includeDisabled?: boolean }) =>
    apiFetch<Template[]>(
      options?.includeDisabled ? '/templates?includeDisabled=true' : '/templates'
    ),

  getById: (id: string) => apiFetch<Template>(`/templates/${id}`),

  update: (id: string, data: { disabled?: boolean; name?: string; description?: string }) =>
    apiFetch<Template>(`/templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  upload: async (file: File, name: string): Promise<Template> => {
    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('name', name);

    return apiFetch<Template>('/templates/upload', {
      method: 'POST',
      body: formData,
    });
  },

  uploadJson: async (file: File): Promise<Template> => {
    const formData = new FormData();
    formData.append('template', file);

    return apiFetch<Template>('/templates/upload-json', {
      method: 'POST',
      body: formData,
    });
  },

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/templates/${id}`, {
      method: 'DELETE',
    }),

  updateManual: (id: string, config: {
    name: string;
    description?: string;
    columns?: 1 | 2;
    accentColor?: string;
    bodyColor?: string;
    bodyFontSizePt?: number;
    titleFontSizePt?: number;
    sectionOrder?: string[];
    leftSectionOrder?: string[];
    rightSectionOrder?: string[];
    nameStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    headerTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    contactStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    titleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    subTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    paragraphStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
  }) =>
    apiFetch<Template>(`/templates/${id}/update-manual`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  createManual: (config: {
    name: string;
    description?: string;
    columns?: 1 | 2;
    accentColor?: string;
    bodyColor?: string;
    bodyFontSizePt?: number;
    titleFontSizePt?: number;
    sectionOrder?: string[];
    leftSectionOrder?: string[];
    rightSectionOrder?: string[];
    nameStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    headerTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    contactStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    titleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    subTitleStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    paragraphStyle?: { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: 'normal' | 'bold' };
    sectionStyles?: Record<string, Record<string, { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string }>>;
  }) =>
    apiFetch<Template>('/templates/create-manual', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
};

export const promptsApi = {
  getAll: () => apiFetch<PromptSummary[]>('/prompts'),

  getById: (id: string) => apiFetch<PromptRecord>(`/prompts/${id}`),

  create: (data: {
    name: string;
    description?: string;
    content: string;
    responseFormat?: PromptResponseFormat;
    allowedVariables?: PromptVariableDefinition[];
  }) =>
    apiFetch<PromptRecord>('/prompts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      content: string;
      responseFormat?: PromptResponseFormat;
      allowedVariables?: PromptVariableDefinition[];
    }
  ) =>
    apiFetch<PromptRecord>(`/prompts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    apiFetch<{ message: string }>(`/prompts/${id}`, {
      method: 'DELETE',
    }),

  validateDraft: (data: {
    id?: string;
    content?: string;
    allowedVariables?: PromptVariableDefinition[];
    sampleValues?: Record<string, string>;
  }) =>
    apiFetch<PromptValidation>('/prompts/validate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  previewDraft: (data: {
    id?: string;
    content?: string;
    allowedVariables?: PromptVariableDefinition[];
    sampleValues?: Record<string, string>;
  }) =>
    apiFetch<PromptPreviewResult>('/prompts/preview', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// Resume API
export const resumeApi = {
  getModels: async () => normalizePublicAppSettings(await apiFetch<PublicAppSettings>('/resume/models')),

  analyze: (jobDescription: string, model: ModelChoice) =>
    apiFetch<JobAnalysis>('/resume/analyze', {
      method: 'POST',
      body: JSON.stringify({ jobDescription, model }),
      timeoutMs: ANALYSIS_REQUEST_TIMEOUT_MS,
    }),

  generate: (data: {
    profileId: string;
    templateId: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    tailoredContent?: TailoredContent;
    companyName: string;
    role: string;
    model: ModelChoice;
    format?: 'pdf' | 'docx' | 'both';
    includeCoverLetterDocx?: boolean;
    includeCoverLetter?: boolean;
    /** Answer from files already on disk instead of regenerating; lets a batch resume. */
    skipExisting?: boolean;
    /** Pin the output path's date segment (YYYY-MM-DD) so a batch's builds share one folder. */
    outputDate?: string;
  }) =>
    apiFetch<
      | {
          filename: string;
          downloadUrl: string;
          tailored: boolean;
          format?: 'pdf' | 'docx';
          /** True when nothing was generated because the files already existed. */
          skipped?: boolean;
          /** The date segment the files were written under. */
          outputDate?: string;
          unconfirmedHardSkills?: string[];
          unconfirmedSoftSkills?: string[];
        }
      | {
          pdf: { filename: string; downloadUrl: string };
          docx: { filename: string; downloadUrl: string };
          coverLetter?: {
            pdf: { filename: string; downloadUrl: string };
            docx?: { filename: string; downloadUrl: string };
          };
          tailored: boolean;
          skipped?: boolean;
          /** The date segment the files were written under. */
          outputDate?: string;
          unconfirmedHardSkills?: string[];
          unconfirmedSoftSkills?: string[];
        }
    >(
      '/resume/generate',
      {
        method: 'POST',
        body: JSON.stringify(data),
        timeoutMs: BUILD_REQUEST_TIMEOUT_MS,
      }
    ),

  /** Whether a build's files are already on disk; costs no model call. */
  existing: (data: {
    profileId: string;
    companyName: string;
    role: string;
    format?: 'pdf' | 'docx' | 'both';
    includeCoverLetterDocx?: boolean;
    includeCoverLetter?: boolean;
    outputDate?: string;
  }) =>
    apiFetch<{ exists: boolean; outputDate?: string }>('/resume/existing', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: QUICK_REQUEST_TIMEOUT_MS,
    }),

  generateAll: (data: {
    templateId?: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    companyName: string;
    role: string;
    model: ModelChoice;
    profileIds?: string[];
    format?: 'pdf' | 'docx' | 'both';
    includeCoverLetterDocx?: boolean;
    includeCoverLetter?: boolean;
    skipExisting?: boolean;
  }) =>
    apiFetch<{
      generated: number;
      /** Profiles whose files were already on disk; nothing generated or spent for them. */
      skipped?: number;
      failed: number;
      results: Array<{
        profileId: string;
        profileName: string;
        pdf?: string;
        docx?: string;
        coverLetterPdf?: string;
        coverLetterDocx?: string;
        skipped?: boolean;
      }>;
      failures: Array<{
        profileId: string;
        profileName: string;
        companyName: string;
        error: string;
        /** Whether the same build can succeed on a later try. */
        retryable?: boolean;
      }>;
      failedCompanies: string[];
      tailored: boolean;
      unconfirmedHardSkills?: string[];
      unconfirmedSoftSkills?: string[];
      outputDate?: string;
    }>('/resume/generate-all', {
      method: 'POST',
      body: JSON.stringify(data),
      // One call tailors every selected profile, so it is at least as long as a single
      // build. The backend answers with a retryable 503 at BUILD_DEADLINE_MS (30 min by
      // default) and this sits just outside that, as the backstop for a reply that never
      // arrives at all rather than as the first thing to give up.
      timeoutMs: BUILD_REQUEST_TIMEOUT_MS,
    }),

  confirmSkill: (data: { type: 'hard' | 'soft'; skill: string }) =>
    apiFetch<{ added: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills/confirm', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  listSkills: (type: 'hard' | 'soft') =>
    apiFetch<{ skills: string[] }>(`/resume/skills?type=${type}`),

  addSkill: (data: { type: 'hard' | 'soft'; skill: string }) =>
    apiFetch<{ added: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateSkill: (data: { type: 'hard' | 'soft'; original: string; skill: string }) =>
    apiFetch<{ updated: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteSkill: (data: { type: 'hard' | 'soft'; skill: string }) =>
    apiFetch<{ deleted: boolean; skill: string; type: 'hard' | 'soft' }>('/resume/skills', {
      method: 'DELETE',
      body: JSON.stringify(data),
    }),

  preview: (data: {
    profileId: string;
    templateId: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    tailoredContent?: TailoredContent;
    model: ModelChoice;
    includeCoverLetter?: boolean;
  }) =>
    apiFetch<{ html: string; tailored: boolean; tailoredContent?: TailoredContent }>('/resume/preview', {
      method: 'POST',
      body: JSON.stringify(data),
      // A preview runs the same tailoring call a build does, minus the rendering.
      timeoutMs: BUILD_REQUEST_TIMEOUT_MS,
    }),

  previewAll: (data: {
    templateId?: string;
    jobDescription?: string;
    jobAnalysis?: JobAnalysis;
    model: ModelChoice;
    profileIds?: string[];
    includeCoverLetter?: boolean;
  }) =>
    apiFetch<{
      previews: Array<{
        profileId: string;
        profileName: string;
        html: string;
        tailoredContent?: TailoredContent;
      }>;
      tailored: boolean;
      unconfirmedHardSkills?: string[];
      unconfirmedSoftSkills?: string[];
    }>('/resume/preview-all', {
      method: 'POST',
      body: JSON.stringify(data),
      // One tailoring call per selected profile — the longest request the builder makes.
      timeoutMs: BUILD_REQUEST_TIMEOUT_MS,
    }),

  getDownloadUrl: (filename: string) =>
    `${getCurrentApiBase()}/resume/download/${filename}`,
};
