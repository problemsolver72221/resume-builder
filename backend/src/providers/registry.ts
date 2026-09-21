/**
 * Single source of truth for AI providers.
 *
 * To add a provider:
 *   1. append a definition to PROVIDER_DEFINITIONS below;
 *   2. add an adapter under ./adapters and register it in ./index.ts
 *      (the ADAPTERS record is typed against ProviderId, so forgetting step 2 fails to compile).
 *
 * Settings persistence, API-key storage, model resolution, and both the admin and builder
 * UIs derive their provider lists from this file — nothing else enumerates providers.
 */

export interface ProviderDefinition {
  /** Stable identifier used in settings, API payloads, and the UI. */
  id: string;
  /** Human-readable name shown in the UI. */
  label: string;
  /** Environment variables checked (in order) for an API key when no stored key is active. */
  envApiKeyNames: readonly string[];
  /**
   * Environment variable that overrides `models`: a comma-separated list whose first entry
   * is the default, so one variable both picks the model and lists the alternatives.
   */
  modelEnvName: string;
  /** Models the builder may choose from when the environment override is unset; the first is the default. */
  models: readonly [string, ...string[]];
  /** Environment variable that overrides the output-token ceiling. */
  maxOutputTokensEnvName: string;
  /**
   * Largest `max_tokens` the app will request from this provider. Requests asking for more
   * are clamped, so a single generous number at the call site is safe for every provider.
   * Some services (you.bot) reserve the worst-case cost of this value up front, so it must
   * also fit the account balance — hence a ceiling rather than "unlimited".
   */
  defaultMaxOutputTokens: number;
  /** Model-id prefixes that map a raw model string to this provider (see resolveProviderId). */
  modelPrefixes: readonly string[];
}

export const PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    label: 'OpenAI',
    envApiKeyNames: ['OPENAI_API_KEY'],
    modelEnvName: 'OPENAI_MODEL',
    models: ['gpt-5.1'],
    maxOutputTokensEnvName: 'OPENAI_MAX_OUTPUT_TOKENS',
    defaultMaxOutputTokens: 16000,
    modelPrefixes: ['gpt-'],
  },
  {
    id: 'claude',
    label: 'Claude',
    envApiKeyNames: ['ANTHROPIC_API_KEY'],
    modelEnvName: 'CLAUDE_MODEL',
    models: ['claude-sonnet-4-20250514'],
    maxOutputTokensEnvName: 'CLAUDE_MAX_OUTPUT_TOKENS',
    defaultMaxOutputTokens: 16000,
    modelPrefixes: ['claude-'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envApiKeyNames: ['OPENROUTER_API_KEY'],
    modelEnvName: 'OPENROUTER_MODEL',
    models: ['openai/gpt-5.4-nano'],
    maxOutputTokensEnvName: 'OPENROUTER_MAX_OUTPUT_TOKENS',
    // Depends on the routed model; 11000 is what the app has always sent and is known to work.
    defaultMaxOutputTokens: 11000,
    modelPrefixes: ['openrouter/'],
  },
  {
    id: 'youbot',
    label: 'you.bot',
    envApiKeyNames: ['YOUBOT_API_KEY'],
    modelEnvName: 'YOUBOT_MODEL',
    models: ['claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5-6-luna', 'gemini-3-7-flash', 'gemini-3-8-flash', 'gemini-3-flash'],
    maxOutputTokensEnvName: 'YOUBOT_MAX_OUTPUT_TOKENS',
    // you.bot reserves (promptTokens + this) * ~0.00055 credits before it runs anything,
    // and refuses with 402 if the balance cannot cover that worst case — even though a
    // typical tailoring call then spends about a seventh of it. Keep this only as high as
    // a modest balance tolerates; raise it (env var) once the account is topped up.
    defaultMaxOutputTokens: 12000,
    modelPrefixes: ['youbot/'],
  },
  {
    id: 'cheapai',
    label: 'CheapAI',
    envApiKeyNames: ['CHEAPAI_API_KEY'],
    modelEnvName: 'CHEAPAI_MODEL',
    // Ids exactly as the catalog at https://cheapai.io/models spells them — with dots
    // (gpt-5.6-luna, gemini-3.7-flash) where you.bot uses dashes.
    models: [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'gpt-5.6-luna',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-fable-5-1',
      'claude-fable-5',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.1-pro-low',
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.5',
      'grok-4.6',
      'grok-4.5',
      'grok-4.20-non-reasoning',
    ],
    maxOutputTokensEnvName: 'CHEAPAI_MAX_OUTPUT_TOKENS',
    defaultMaxOutputTokens: 16000,
    modelPrefixes: ['cheapai/'],
  },
] as const satisfies readonly ProviderDefinition[];

export type ProviderId = (typeof PROVIDER_DEFINITIONS)[number]['id'];

/** A definition whose id is known to be registered. */
export type RegisteredProvider = ProviderDefinition & { id: ProviderId };

export const PROVIDER_IDS: readonly ProviderId[] = PROVIDER_DEFINITIONS.map((definition) => definition.id);

/** Provider assumed when a request names none, and re-enabled if every provider gets switched off. */
export const DEFAULT_PROVIDER_ID: ProviderId = PROVIDER_DEFINITIONS[0].id;

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function listProviderDefinitions(): readonly RegisteredProvider[] {
  return PROVIDER_DEFINITIONS;
}

export function getProviderDefinition(id: ProviderId): RegisteredProvider {
  const definition = PROVIDER_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    throw new Error(`Unknown AI provider "${id}"`);
  }
  return definition;
}

/**
 * Maps a provider id or a raw model string (e.g. "gpt-4o", "claude-3-opus") to a provider.
 * Unknown or missing values resolve to DEFAULT_PROVIDER_ID.
 */
export function resolveProviderId(model?: string | null): ProviderId {
  if (isProviderId(model)) {
    return model;
  }
  if (typeof model === 'string') {
    const match = PROVIDER_DEFINITIONS.find((definition) =>
      definition.modelPrefixes.some((prefix) => model.startsWith(prefix))
    );
    if (match) {
      return match.id;
    }
  }
  return DEFAULT_PROVIDER_ID;
}

function parseModelList(raw: string | undefined): string[] {
  const models = (raw ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return models.filter((model, index) => models.indexOf(model) === index);
}

/**
 * Models the builder may offer for the provider — the environment list when set, else the
 * registry's. The first entry is what a request gets when it names only the provider.
 */
export function getProviderModels(id: ProviderId): readonly string[] {
  const definition = getProviderDefinition(id);
  const fromEnvironment = parseModelList(process.env[definition.modelEnvName]);
  return fromEnvironment.length > 0 ? fromEnvironment : definition.models;
}

/** The provider's default model: the first of getProviderModels. */
export function getProviderModel(id: ProviderId): string {
  return getProviderModels(id)[0];
}

/** A provider together with the model to run on it. */
export interface ModelSelection {
  providerId: ProviderId;
  model: string;
}

/** What callers may name: a bare provider (meaning its default model) or an explicit selection. */
export type ModelTarget = ProviderId | ModelSelection;

export class UnknownModelError extends Error {
  constructor(providerId: ProviderId, model: string) {
    super(
      `${getProviderDefinition(providerId).label} does not offer the model "${model}"; ` +
        `available: ${getProviderModels(providerId).join(', ')}`
    );
    this.name = 'UnknownModelError';
  }
}

/**
 * Resolves what a request asked to run on: the wire form "<providerId>/<model>", a bare
 * provider id (its default model), or a raw model string mapped through resolveProviderId.
 * A known provider with a model it does not list throws UnknownModelError — running its
 * default instead would silently bill a different model than the one chosen.
 */
export function resolveModelSelection(value?: string | null): ModelSelection {
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    const head = slash > 0 ? value.slice(0, slash) : '';
    if (isProviderId(head)) {
      const model = value.slice(slash + 1).trim();
      if (!getProviderModels(head).includes(model)) {
        throw new UnknownModelError(head, model);
      }
      return { providerId: head, model };
    }
  }
  const providerId = resolveProviderId(value);
  return { providerId, model: getProviderModel(providerId) };
}

export function toModelSelection(target: ModelTarget): ModelSelection {
  return typeof target === 'string' ? resolveModelSelection(target) : target;
}

/** Output-token ceiling for the provider: environment override (a positive integer) first, then the registry default. */
export function getProviderMaxOutputTokens(id: ProviderId): number {
  const definition = getProviderDefinition(id);
  const override = Number(process.env[definition.maxOutputTokensEnvName]?.trim());
  return Number.isInteger(override) && override > 0 ? override : definition.defaultMaxOutputTokens;
}

/** First non-empty API key found in the provider's environment variables, or ''. */
export function getProviderEnvironmentApiKey(id: ProviderId): string {
  for (const name of getProviderDefinition(id).envApiKeyNames) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
}

/** Builds a record with one entry per provider, so provider-keyed shapes stay exhaustive by construction. */
export function buildProviderRecord<T>(build: (definition: RegisteredProvider) => T): Record<ProviderId, T> {
  const record = {} as Record<ProviderId, T>;
  for (const definition of PROVIDER_DEFINITIONS) {
    record[definition.id] = build(definition);
  }
  return record;
}
