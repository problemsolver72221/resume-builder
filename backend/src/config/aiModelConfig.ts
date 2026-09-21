import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  buildProviderRecord,
  DEFAULT_PROVIDER_ID,
  getProviderEnvironmentApiKey,
  getProviderModel,
  getProviderModels,
  isProviderId,
  listProviderDefinitions,
  type ProviderId,
} from '../providers/registry';
import {
  buildOutputPathPreview,
  DEFAULT_OUTPUT_PATH_TEMPLATE,
  DEFAULT_GENERATED_RESUMES_DIR,
  ensureWritableOutputDir,
  normalizeOutputBaseDir,
  normalizeOutputPathTemplate,
  outputPathTemplateUsesJobTitle,
  validateOutputPathTemplate,
} from '../utils/outputStorage';

export type DefaultMode = 'preview' | 'generate';
export type ThemeMode = 'light' | 'dark';
export type DefaultResumeSelection = 'single' | 'all' | 'group';

type ApiKeyEntry = {
  id: string;
  name: string;
  value: string;
  createdAt: string;
};

type ProviderKeyStore = {
  activeKeyId: string;
  entries: ApiKeyEntry[];
};

type ProviderKeyStores = Record<ProviderId, ProviderKeyStore>;

type ApiKeyUpdate = {
  activeKeyId?: string;
  add?: Array<{
    clientId?: string;
    name?: string;
    value: string;
  }>;
  removeIds?: string[];
  useEnvironmentFallback?: boolean;
};

type GoogleSheetSource = {
  id: string;
  name: string;
  sheetId: string;
  createdAt: string;
  updatedAt: string;
};

type AppSettings = {
  /** Which providers the builder may use, keyed by provider id. */
  enabledProviders: Record<ProviderId, boolean>;
  /** Provider pre-selected in the builder; '' means "first usable provider". */
  defaultProviderId: ProviderId | '';
  defaultMode: DefaultMode;
  defaultTheme: ThemeMode;
  defaultResumeSelection: DefaultResumeSelection;
  defaultGroupId: string;
  defaultProfileId: string;
  defaultResumeDocxEnabled: boolean;
  defaultCoverLetterDocxEnabled: boolean;
  /** When false the builder skips the cover letter: no AI call for it, and no files. */
  defaultCoverLetterEnabled: boolean;
  outputBaseDir: string;
  outputPathTemplate: string;
  googleSheetsSources: GoogleSheetSource[];
  apiKeys: ProviderKeyStores;
};

/** Provider state that is safe to expose to the unauthenticated builder UI. */
export type ProviderSummary = {
  id: ProviderId;
  label: string;
  /** The model a request gets when it names only the provider: the first of `models`. */
  model: string;
  /** Models the builder may choose from for this provider. */
  models: readonly string[];
  enabled: boolean;
  /** True when a stored key is active or an environment key is present. */
  configured: boolean;
};

export type AIModelSettings = Pick<AppSettings, 'enabledProviders' | 'defaultProviderId'>;

export type PublicAppSettings = Pick<
  AppSettings,
  | 'defaultProviderId'
  | 'defaultMode'
  | 'defaultTheme'
  | 'defaultResumeSelection'
  | 'defaultGroupId'
  | 'defaultProfileId'
  | 'defaultResumeDocxEnabled'
  | 'defaultCoverLetterDocxEnabled'
  | 'defaultCoverLetterEnabled'
  | 'googleSheetsSources'
> & {
  providers: ProviderSummary[];
};
export type PublicAppSettingsWithDerived = PublicAppSettings & {
  outputPathUsesJobTitle: boolean;
};

export type AdminProviderKeyState = {
  configured: boolean;
  activeSource: 'stored' | 'environment' | 'none';
  activeKeyId: string | null;
  activePreview: string | null;
  environmentPreview: string | null;
  entries: Array<{
    id: string;
    name: string;
    preview: string | null;
    isActive: boolean;
    createdAt: string;
  }>;
};

export type AdminAppSettings = PublicAppSettingsWithDerived & {
  outputBaseDir: string;
  outputPathTemplate: string;
  outputPathPreview: string;
  apiKeys: Record<ProviderId, AdminProviderKeyState>;
};

export type AppSettingsUpdate = Partial<Omit<PublicAppSettings, 'providers'>> & {
  enabledProviders?: Partial<Record<ProviderId, boolean>>;
  outputBaseDir?: string;
  outputPathTemplate?: string;
  apiKeys?: Partial<Record<ProviderId, ApiKeyUpdate | string>>;
};

const DATA_DIR = process.env.TAILOR_DATA_DIR
  ? path.resolve(process.env.TAILOR_DATA_DIR)
  : path.join(__dirname, '../../data');
const CONFIG_DIR = path.join(DATA_DIR, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'ai-models.json');

const DEFAULT_SETTINGS: AppSettings = {
  enabledProviders: buildProviderRecord(() => true),
  defaultProviderId: '',
  defaultMode: 'preview',
  defaultTheme: 'light',
  defaultResumeSelection: 'single',
  defaultGroupId: '',
  defaultProfileId: '',
  defaultResumeDocxEnabled: true,
  defaultCoverLetterDocxEnabled: true,
  defaultCoverLetterEnabled: true,
  outputBaseDir: DEFAULT_GENERATED_RESUMES_DIR,
  outputPathTemplate: DEFAULT_OUTPUT_PATH_TEMPLATE,
  googleSheetsSources: [],
  apiKeys: buildProviderRecord(() => ({ activeKeyId: '', entries: [] })),
};

function normalizeThemeMode(value: unknown, fallback: ThemeMode): ThemeMode {
  return value === 'light' || value === 'dark' ? value : fallback;
}

function normalizeDefaultMode(value: unknown, fallback: DefaultMode): DefaultMode {
  return value === 'preview' || value === 'generate' ? value : fallback;
}

function normalizeDefaultResumeSelection(
  value: unknown,
  fallback: DefaultResumeSelection
): DefaultResumeSelection {
  return value === 'single' || value === 'all' || value === 'group' ? value : fallback;
}

function normalizeDefaultProviderId(value: unknown, fallback: ProviderId | ''): ProviderId | '' {
  if (isProviderId(value)) return value;
  // Any other string (including the id of a provider that no longer exists) means "no preference".
  if (typeof value === 'string') return '';
  return fallback;
}

/**
 * Reads provider flags from `enabledProviders`, falling back to the flat `<id>Enabled`
 * booleans written by settings files and clients that predate the provider registry.
 */
function normalizeEnabledProviders(
  source: Record<string, unknown>,
  fallback: Record<ProviderId, boolean>
): Record<ProviderId, boolean> {
  const explicit =
    typeof source.enabledProviders === 'object' && source.enabledProviders !== null
      ? (source.enabledProviders as Record<string, unknown>)
      : {};

  return buildProviderRecord((definition) => {
    const value = explicit[definition.id];
    if (typeof value === 'boolean') return value;
    const legacy = source[`${definition.id}Enabled`];
    if (typeof legacy === 'boolean') return legacy;
    return fallback[definition.id];
  });
}

function normalizeApiKeyName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function createApiKeyEntry(value: string, name: string, createdAt?: string): ApiKeyEntry {
  return {
    id: randomUUID(),
    name,
    value,
    createdAt: createdAt || new Date().toISOString(),
  };
}

function normalizeProviderKeyStore(input: unknown, fallback: ProviderKeyStore): ProviderKeyStore {
  if (typeof input === 'string') {
    const value = input.trim();
    if (!value) {
      return { activeKeyId: '', entries: [] };
    }
    const entry = createApiKeyEntry(value, 'Primary key');
    return {
      activeKeyId: entry.id,
      entries: [entry],
    };
  }

  const source = typeof input === 'object' && input !== null ? input as Partial<ProviderKeyStore> & {
    entries?: unknown;
    activeKeyId?: unknown;
  } : {};

  const rawEntries: unknown[] = Array.isArray(source.entries) ? source.entries : fallback.entries;
  const entries = rawEntries
    .map((entry, index) => {
      if (typeof entry === 'string') {
        const value = entry.trim();
        if (!value) return null;
        return createApiKeyEntry(value, `Key ${index + 1}`);
      }
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const raw = entry as Partial<ApiKeyEntry>;
      const value = typeof raw.value === 'string' ? raw.value.trim() : '';
      if (!value) return null;
      return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID(),
        name: normalizeApiKeyName(raw.name, `Key ${index + 1}`),
        value,
        createdAt: typeof raw.createdAt === 'string' && raw.createdAt.trim()
          ? raw.createdAt.trim()
          : new Date().toISOString(),
      } satisfies ApiKeyEntry;
    })
    .filter((entry): entry is ApiKeyEntry => Boolean(entry));

  // An explicit empty activeKeyId is the "environment fallback" choice from the admin UI and
  // must survive a round trip; only a missing or stale id falls back to the first stored key.
  const rawActiveKeyId = typeof source.activeKeyId === 'string' ? source.activeKeyId.trim() : undefined;
  if (rawActiveKeyId === '' && entries.length > 0) {
    return { activeKeyId: '', entries };
  }

  const activeKeyId = rawActiveKeyId ?? fallback.activeKeyId;
  const hasActiveEntry = entries.some((entry) => entry.id === activeKeyId);

  return {
    activeKeyId: entries.length === 0 ? '' : hasActiveEntry ? activeKeyId : entries[0].id,
    entries,
  };
}

function normalizeProviderKeyStores(input: unknown, fallback: ProviderKeyStores): ProviderKeyStores {
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  return buildProviderRecord((definition) =>
    normalizeProviderKeyStore(source[definition.id], fallback[definition.id])
  );
}

function normalizeGoogleSheetSourceName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeGoogleSheetsSources(input: unknown, fallback: GoogleSheetSource[]): GoogleSheetSource[] {
  const rawEntries = Array.isArray(input) ? input : fallback;
  const seenIds = new Set<string>();

  return rawEntries
    .map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }

      const raw = entry as Partial<GoogleSheetSource>;
      const sheetId = typeof raw.sheetId === 'string' ? raw.sheetId.trim() : '';
      if (!sheetId) {
        return null;
      }

      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID();
      if (seenIds.has(id)) {
        return null;
      }
      seenIds.add(id);

      const createdAt = typeof raw.createdAt === 'string' && raw.createdAt.trim()
        ? raw.createdAt.trim()
        : new Date().toISOString();
      const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
        ? raw.updatedAt.trim()
        : createdAt;

      return {
        id,
        name: normalizeGoogleSheetSourceName(raw.name, `Google Sheet ${index + 1}`),
        sheetId,
        createdAt,
        updatedAt,
      } satisfies GoogleSheetSource;
    })
    .filter((entry): entry is GoogleSheetSource => Boolean(entry));
}

type NormalizeOptions = {
  /** Keep the stored template instead of throwing when it is invalid (used when reading the file). */
  lenient?: boolean;
};

function normalizeOutputPathTemplateSetting(value: unknown, fallback: string, lenient: boolean): string {
  try {
    return validateOutputPathTemplate(normalizeOutputPathTemplate(value ?? fallback));
  } catch (error) {
    if (!lenient) throw error;
    console.warn(
      `Ignoring invalid stored output path template ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`
    );
    return fallback;
  }
}

function normalizeSettings(
  input: unknown,
  fallback: AppSettings = DEFAULT_SETTINGS,
  options: NormalizeOptions = {}
): AppSettings {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown> &
    Partial<AppSettings>;

  return {
    enabledProviders: normalizeEnabledProviders(source, fallback.enabledProviders),
    defaultProviderId: normalizeDefaultProviderId(source.defaultProviderId, fallback.defaultProviderId),
    defaultMode: normalizeDefaultMode(source.defaultMode, fallback.defaultMode),
    defaultTheme: normalizeThemeMode(source.defaultTheme, fallback.defaultTheme),
    defaultResumeSelection: normalizeDefaultResumeSelection(
      source.defaultResumeSelection,
      fallback.defaultResumeSelection
    ),
    defaultGroupId: typeof source.defaultGroupId === 'string' ? source.defaultGroupId.trim() : fallback.defaultGroupId,
    defaultProfileId: typeof source.defaultProfileId === 'string'
      ? source.defaultProfileId.trim()
      : fallback.defaultProfileId,
    defaultResumeDocxEnabled: typeof source.defaultResumeDocxEnabled === 'boolean'
      ? source.defaultResumeDocxEnabled
      : fallback.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: typeof source.defaultCoverLetterDocxEnabled === 'boolean'
      ? source.defaultCoverLetterDocxEnabled
      : fallback.defaultCoverLetterDocxEnabled,
    defaultCoverLetterEnabled: typeof source.defaultCoverLetterEnabled === 'boolean'
      ? source.defaultCoverLetterEnabled
      : fallback.defaultCoverLetterEnabled,
    outputBaseDir: normalizeOutputBaseDir(source.outputBaseDir ?? fallback.outputBaseDir),
    outputPathTemplate: normalizeOutputPathTemplateSetting(
      source.outputPathTemplate,
      fallback.outputPathTemplate,
      options.lenient === true
    ),
    googleSheetsSources: normalizeGoogleSheetsSources(source.googleSheetsSources, fallback.googleSheetsSources),
    apiKeys: normalizeProviderKeyStores(source.apiKeys, fallback.apiKeys),
  };
}

function hasEnabledProvider(settings: Pick<AppSettings, 'enabledProviders'>): boolean {
  return Object.values(settings.enabledProviders).some(Boolean);
}

function ensureAtLeastOneProviderEnabled(settings: AppSettings): AppSettings {
  if (hasEnabledProvider(settings)) {
    return settings;
  }

  return {
    ...settings,
    enabledProviders: { ...settings.enabledProviders, [DEFAULT_PROVIDER_ID]: true },
  };
}

function maskApiKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/** '' means "use the environment key" even when stored keys exist; normalisation keeps it that way. */
function getStoredActiveApiKey(store: ProviderKeyStore): ApiKeyEntry | null {
  if (!store.entries.length || !store.activeKeyId) return null;
  return store.entries.find((entry) => entry.id === store.activeKeyId) ?? null;
}

function isProviderConfigured(provider: ProviderId, store: ProviderKeyStore): boolean {
  return Boolean(getStoredActiveApiKey(store)) || Boolean(getProviderEnvironmentApiKey(provider));
}

function toProviderSummaries(settings: AppSettings): ProviderSummary[] {
  return listProviderDefinitions().map((definition) => ({
    id: definition.id,
    label: definition.label,
    model: getProviderModel(definition.id),
    models: getProviderModels(definition.id),
    enabled: settings.enabledProviders[definition.id],
    configured: isProviderConfigured(definition.id, settings.apiKeys[definition.id]),
  }));
}

function toPublicSettings(settings: AppSettings): PublicAppSettings {
  return {
    providers: toProviderSummaries(settings),
    defaultProviderId: settings.defaultProviderId,
    defaultMode: settings.defaultMode,
    defaultTheme: settings.defaultTheme,
    defaultResumeSelection: settings.defaultResumeSelection,
    defaultGroupId: settings.defaultGroupId,
    defaultProfileId: settings.defaultProfileId,
    defaultResumeDocxEnabled: settings.defaultResumeDocxEnabled,
    defaultCoverLetterDocxEnabled: settings.defaultCoverLetterDocxEnabled,
    defaultCoverLetterEnabled: settings.defaultCoverLetterEnabled,
    googleSheetsSources: settings.googleSheetsSources,
  };
}

function toPublicSettingsWithDerived(settings: AppSettings): PublicAppSettingsWithDerived {
  return {
    ...toPublicSettings(settings),
    outputPathUsesJobTitle: outputPathTemplateUsesJobTitle(settings.outputPathTemplate),
  };
}

function toAdminSettings(settings: AppSettings): AdminAppSettings {
  return {
    ...toPublicSettingsWithDerived(settings),
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
    outputPathPreview: buildOutputPathPreview(settings.outputPathTemplate),
    apiKeys: buildProviderRecord((definition) =>
      toAdminProviderKeyState(definition.id, settings.apiKeys[definition.id])
    ),
  };
}

function toAdminProviderKeyState(provider: ProviderId, store: ProviderKeyStore): AdminProviderKeyState {
  const activeStoredEntry = getStoredActiveApiKey(store);
  const environmentValue = getProviderEnvironmentApiKey(provider);
  const environmentPreview = maskApiKey(environmentValue);
  // Stored keys are listed even while the environment key is active, so the admin UI can
  // show them and switch back to one.
  const entries = store.entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    preview: maskApiKey(entry.value),
    isActive: entry.id === activeStoredEntry?.id,
    createdAt: entry.createdAt,
  }));

  if (activeStoredEntry) {
    return {
      configured: true,
      activeSource: 'stored',
      activeKeyId: activeStoredEntry.id,
      activePreview: maskApiKey(activeStoredEntry.value),
      environmentPreview,
      entries,
    };
  }

  if (environmentValue) {
    return {
      configured: true,
      activeSource: 'environment',
      activeKeyId: null,
      activePreview: environmentPreview,
      environmentPreview,
      entries,
    };
  }

  return {
    configured: false,
    activeSource: 'none',
    activeKeyId: null,
    activePreview: null,
    environmentPreview: null,
    entries,
  };
}

async function ensureConfigDir(): Promise<void> {
  try {
    await fs.access(CONFIG_DIR);
  } catch {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
  }
}

const TRANSIENT_READ_RETRY_MS = 50;

async function readConfigFile(): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.readFile(CONFIG_FILE, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // Sync clients and antivirus briefly lock files on Windows; one short retry covers
      // that. Anything else propagates — a read hiccup must never replace the file.
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_READ_RETRY_MS));
    }
  }
}

/**
 * Reads settings without writing them back. The file only changes through updateAppSettings,
 * and an unparseable file is moved aside for recovery rather than overwritten, because it
 * is where stored API keys live.
 */
async function readSettingsFile(): Promise<AppSettings> {
  await ensureConfigDir();

  const raw = await readConfigFile();
  if (raw === null) {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return DEFAULT_SETTINGS;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const backup = `${CONFIG_FILE}.corrupt-${Date.now()}`;
    await fs.rename(CONFIG_FILE, backup).catch(() => undefined);
    console.error(`Settings file is not valid JSON; moved it to ${backup} and restored defaults.`, error);
    await fs.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return DEFAULT_SETTINGS;
  }

  return ensureAtLeastOneProviderEnabled(normalizeSettings(parsed, DEFAULT_SETTINGS, { lenient: true }));
}

async function readSettings(): Promise<AppSettings> {
  return readSettingsFile();
}

async function writeSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized = ensureAtLeastOneProviderEnabled(normalizeSettings(settings));
  await ensureConfigDir();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function applyApiKeyUpdate(current: ProviderKeyStore, update: ApiKeyUpdate | string | undefined): ProviderKeyStore {
  if (typeof update === 'undefined') {
    return current;
  }

  if (typeof update === 'string') {
    const value = update.trim();
    if (!value) {
      return { activeKeyId: '', entries: [] };
    }
    const entry = createApiKeyEntry(value, 'Primary key');
    return {
      activeKeyId: entry.id,
      entries: [entry],
    };
  }

  const removeIds = new Set((update.removeIds ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0));
  const retainedEntries = current.entries.filter((entry) => !removeIds.has(entry.id));
  const addedEntries = (update.add ?? [])
    .map((entry, index) => {
      const value = typeof entry?.value === 'string' ? entry.value.trim() : '';
      if (!value) return null;
      return {
        clientId: typeof entry?.clientId === 'string' ? entry.clientId.trim() : '',
        stored: createApiKeyEntry(value, normalizeApiKeyName(entry?.name, `Key ${retainedEntries.length + index + 1}`)),
      };
    })
    .filter((entry): entry is { clientId: string; stored: ApiKeyEntry } => Boolean(entry));

  const entries = [...retainedEntries, ...addedEntries.map((entry) => entry.stored)];
  if (entries.length === 0 || update.useEnvironmentFallback) {
    return { activeKeyId: '', entries };
  }

  const requestedActiveKeyId = typeof update.activeKeyId === 'string' ? update.activeKeyId.trim() : current.activeKeyId;
  const matchingNewEntry = addedEntries.find((entry) => entry.clientId && entry.clientId === requestedActiveKeyId);
  const activeKeyId = entries.some((entry) => entry.id === requestedActiveKeyId)
    ? requestedActiveKeyId
    : matchingNewEntry?.stored.id || entries[0].id;

  return {
    activeKeyId,
    entries,
  };
}

export async function getAppSettings(): Promise<AppSettings> {
  return readSettings();
}

export async function getPublicAppSettings(): Promise<PublicAppSettingsWithDerived> {
  return toPublicSettingsWithDerived(await readSettings());
}

export async function getAdminAppSettings(): Promise<AdminAppSettings> {
  return toAdminSettings(await readSettings());
}

export async function updateAppSettings(input: AppSettingsUpdate): Promise<AdminAppSettings> {
  const current = await readSettings();
  const nextBase = normalizeSettings(
    {
      ...current,
      ...input,
      // Only the flags present in this update override stored ones; normalizeSettings falls back per id.
      enabledProviders: input.enabledProviders ?? {},
      apiKeys: current.apiKeys,
    },
    current
  );

  const next: AppSettings = {
    ...nextBase,
    apiKeys: buildProviderRecord((definition) =>
      applyApiKeyUpdate(current.apiKeys[definition.id], input.apiKeys?.[definition.id])
    ),
  };

  if (!hasEnabledProvider(next)) {
    throw new Error('At least one AI model must remain enabled');
  }

  const shouldValidateOutputDir =
    typeof input.outputBaseDir !== 'undefined' ||
    current.outputBaseDir !== next.outputBaseDir;

  if (shouldValidateOutputDir) {
    await ensureWritableOutputDir(next.outputBaseDir);
  }

  const saved = await writeSettings(next);
  return toAdminSettings(saved);
}

export async function getAIModelSettings(): Promise<AIModelSettings> {
  const settings = await readSettings();
  return {
    enabledProviders: settings.enabledProviders,
    defaultProviderId: settings.defaultProviderId,
  };
}

/** Opt-in trace of which key each call used (set AI_KEY_DEBUG=1); keys are always masked. */
function traceKeySource(provider: ProviderId, source: 'stored' | 'environment', key: string): void {
  if (process.env.AI_KEY_DEBUG === '1') {
    console.log(`[AI_KEY_DEBUG] provider=${provider} source=${source} key=${maskApiKey(key) ?? 'missing'}`);
  }
}

export async function getProviderApiKey(provider: ProviderId): Promise<string> {
  const settings = await readSettings();
  const activeStoredKey = getStoredActiveApiKey(settings.apiKeys[provider]);
  if (activeStoredKey?.value.trim()) {
    const resolved = activeStoredKey.value.trim();
    traceKeySource(provider, 'stored', resolved);
    return resolved;
  }

  const environmentKey = getProviderEnvironmentApiKey(provider);
  traceKeySource(provider, 'environment', environmentKey);
  return environmentKey;
}

export async function getOutputStorageSettings(): Promise<Pick<AppSettings, 'outputBaseDir' | 'outputPathTemplate'>> {
  const settings = await readSettings();
  return {
    outputBaseDir: settings.outputBaseDir,
    outputPathTemplate: settings.outputPathTemplate,
  };
}

export function isProviderEnabled(provider: ProviderId, settings: AIModelSettings): boolean {
  return settings.enabledProviders[provider] === true;
}

/** The configured default provider when it is enabled, otherwise the first enabled provider in registry order. */
export function getDefaultEnabledProvider(settings: AIModelSettings): ProviderId {
  if (settings.defaultProviderId && settings.enabledProviders[settings.defaultProviderId]) {
    return settings.defaultProviderId;
  }
  const firstEnabled = listProviderDefinitions().find((definition) => settings.enabledProviders[definition.id]);
  return firstEnabled?.id ?? DEFAULT_PROVIDER_ID;
}
