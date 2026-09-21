import type { AIProvider, ModelChoice, ProviderInfo, PublicAppSettings } from './api';

type ProviderSettings = Pick<PublicAppSettings, 'providers' | 'defaultProviderId'>;

/** One entry of the builder's model picker: a provider paired with one of its listed models. */
export interface ModelOption {
  /** Sent to the backend as `model`. */
  value: ModelChoice;
  providerId: AIProvider;
  model: string;
  label: string;
  configured: boolean;
}

function getEnabledProviders(settings: ProviderSettings): ProviderInfo[] {
  return settings.providers.filter((provider) => provider.enabled);
}

/** Every model of every enabled provider, in registry order, labelled like "you.bot · claude-haiku-4-5". */
export function listModelOptions(settings: ProviderSettings): ModelOption[] {
  return getEnabledProviders(settings).flatMap((provider) =>
    provider.models.map((model) => ({
      value: `${provider.id}/${model}`,
      providerId: provider.id,
      model,
      label: `${provider.label} · ${model}${provider.configured ? '' : ' (no API key)'}`,
      configured: provider.configured,
    }))
  );
}

/**
 * Chooses the option to pre-select: the current choice while it is still offered, then the
 * admin default provider's first model, then the first provider that has an API key, then any.
 */
export function pickDefaultModel(settings: ProviderSettings, current?: ModelChoice | null): ModelChoice {
  const options = listModelOptions(settings);
  if (current && options.some((option) => option.value === current)) return current;
  const preferred = settings.defaultProviderId
    ? options.find((option) => option.providerId === settings.defaultProviderId)
    : undefined;
  return (preferred ?? options.find((option) => option.configured) ?? options[0])?.value ?? '';
}
