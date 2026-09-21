const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { loadFresh, makeTempDataDir, readJson } = require('./helpers');

const PROVIDER_KEY_ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'YOUBOT_API_KEY', 'CHEAPAI_API_KEY'];
const DEFAULT_TEMPLATE = '/{{profile name}}/{{date}}/{{company name}}/{{job title}}';

function clearProviderEnv() {
  for (const name of PROVIDER_KEY_ENV) {
    process.env[name] = '';
  }
}

function enabledById(settings) {
  return Object.fromEntries(settings.providers.map((provider) => [provider.id, provider.enabled]));
}

test('app settings persist entirely in JSON', async () => {
  const dataDir = makeTempDataDir('settings');
  const outputDir = path.join(dataDir, 'generated-output');
  process.env.TAILOR_DATA_DIR = dataDir;
  clearProviderEnv();
  const config = loadFresh('../dist/config/aiModelConfig');

  const defaults = await config.getAdminAppSettings();
  assert.deepEqual(defaults.providers.map((provider) => provider.id), ['openai', 'claude', 'openrouter', 'youbot', 'cheapai']);
  assert.ok(defaults.providers.every((provider) => provider.enabled && !provider.configured));
  assert.equal(defaults.providers.find((provider) => provider.id === 'youbot').model, 'claude-sonnet-5');
  assert.deepEqual(defaults.providers.find((provider) => provider.id === 'youbot').models, ['claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5-6-luna', 'gemini-3-7-flash', 'gemini-3-8-flash', 'gemini-3-flash']);
  assert.equal(defaults.defaultProviderId, '');
  assert.equal(defaults.defaultMode, 'preview');
  // Letters are written unless an admin turns them off.
  assert.equal(defaults.defaultCoverLetterEnabled, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'config', 'ai-models.json')), true);

  const updated = await config.updateAppSettings({
    enabledProviders: { openai: false, openrouter: false },
    defaultProviderId: 'youbot',
    defaultMode: 'generate',
    defaultTheme: 'dark',
    defaultResumeSelection: 'group',
    defaultGroupId: 'group-1',
    defaultProfileId: 'profile-1',
    defaultResumeDocxEnabled: false,
    defaultCoverLetterDocxEnabled: false,
    defaultCoverLetterEnabled: false,
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{date}}/{{profile name}}/{{company name}}',
    googleSheetsSources: [{
      id: 'sheet-1',
      name: 'Applications',
      sheetId: 'abc123',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    }],
    apiKeys: {
      claude: {
        add: [{ clientId: 'new-claude', name: 'Claude Test', value: 'claude-secret' }],
        activeKeyId: 'new-claude',
      },
    },
  });

  assert.deepEqual(enabledById(updated), { openai: false, claude: true, openrouter: false, youbot: true, cheapai: true });
  assert.equal(updated.defaultProviderId, 'youbot');
  assert.equal(updated.defaultMode, 'generate');
  assert.equal(updated.defaultTheme, 'dark');
  assert.equal(updated.defaultCoverLetterEnabled, false);
  assert.equal(updated.outputBaseDir, outputDir);
  assert.equal(updated.googleSheetsSources.length, 1);
  assert.equal(updated.apiKeys.claude.entries.length, 1);
  assert.equal(updated.apiKeys.claude.activeSource, 'stored');
  assert.equal(updated.apiKeys.claude.activePreview, 'clau...cret');
  assert.equal(updated.providers.find((provider) => provider.id === 'claude').configured, true);
  assert.equal(await config.getProviderApiKey('claude'), 'claude-secret');

  const stored = readJson(path.join(dataDir, 'config', 'ai-models.json'));
  assert.deepEqual(stored.enabledProviders, { openai: false, claude: true, openrouter: false, youbot: true, cheapai: true });
  assert.equal(stored.defaultProviderId, 'youbot');
  assert.equal(stored.defaultCoverLetterEnabled, false, 'the toggle survives a round trip through disk');
  assert.equal(stored.apiKeys.claude.entries[0].value, 'claude-secret');
  assert.equal(stored.googleSheetsSources[0].sheetId, 'abc123');
  assert.equal('openaiEnabled' in stored, false);
  assert.equal(fs.existsSync(path.join(dataDir, 'config', 'settings.sqlite')), false);
});

test('legacy flat provider flags migrate into enabledProviders without losing stored keys', async (t) => {
  const dataDir = makeTempDataDir('settings-legacy');
  process.env.TAILOR_DATA_DIR = dataDir;
  clearProviderEnv();
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const legacyFile = JSON.stringify({
    openaiEnabled: false,
    claudeEnabled: true,
    openrouterEnabled: false,
    defaultMode: 'generate',
    // Invalid on purpose: a bad stored template must not make the whole file unreadable.
    outputPathTemplate: '/{{nope}}',
    apiKeys: {
      openrouter: {
        activeKeyId: 'k1',
        entries: [{ id: 'k1', name: 'Primary', value: 'openrouter-secret', createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    },
  });
  fs.writeFileSync(path.join(configDir, 'ai-models.json'), legacyFile);
  const config = loadFresh('../dist/config/aiModelConfig');
  t.mock.method(console, 'warn', () => {});

  const admin = await config.getAdminAppSettings();
  // youbot did not exist when this file was written, so it takes the default (enabled).
  assert.deepEqual(enabledById(admin), { openai: false, claude: true, openrouter: false, youbot: true, cheapai: true });
  assert.equal(admin.defaultProviderId, '');
  assert.equal(admin.defaultMode, 'generate');
  assert.equal(admin.outputPathTemplate, DEFAULT_TEMPLATE, 'the invalid template is ignored on read');
  assert.equal(admin.apiKeys.openrouter.activeSource, 'stored');
  assert.equal(await config.getProviderApiKey('openrouter'), 'openrouter-secret');

  // Reading never rewrites the file; the legacy shape is still on disk untouched.
  assert.equal(fs.readFileSync(path.join(configDir, 'ai-models.json'), 'utf8'), legacyFile);

  // A client still sending the flat flags is honoured on update, which is when the file migrates.
  const updated = await config.updateAppSettings({ openaiEnabled: true });
  assert.deepEqual(enabledById(updated), { openai: true, claude: true, openrouter: false, youbot: true, cheapai: true });
  const stored = readJson(path.join(configDir, 'ai-models.json'));
  assert.deepEqual(stored.enabledProviders, { openai: true, claude: true, openrouter: false, youbot: true, cheapai: true });
  assert.equal(stored.apiKeys.openrouter.entries[0].value, 'openrouter-secret');
  assert.equal(stored.outputPathTemplate, DEFAULT_TEMPLATE);
  assert.equal('openaiEnabled' in stored, false);

  // An invalid template submitted by the admin is still rejected, not silently swapped.
  await assert.rejects(() => config.updateAppSettings({ outputPathTemplate: '/{{nope}}' }), /Unsupported output path token/);
});

test('an unreadable settings file is moved aside for recovery, never overwritten', async (t) => {
  const dataDir = makeTempDataDir('settings-corrupt');
  process.env.TAILOR_DATA_DIR = dataDir;
  clearProviderEnv();
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const garbage = '{"apiKeys":{"openrouter":{"entries":[{"id":"k","value":"precious-key"';
  fs.writeFileSync(path.join(configDir, 'ai-models.json'), garbage);
  const config = loadFresh('../dist/config/aiModelConfig');
  t.mock.method(console, 'error', () => {});

  const admin = await config.getAdminAppSettings();
  assert.equal(admin.apiKeys.openrouter.configured, false);

  const backups = fs.readdirSync(configDir).filter((name) => name.startsWith('ai-models.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(configDir, backups[0]), 'utf8'), garbage, 'the original bytes are kept');
  assert.equal(readJson(path.join(configDir, 'ai-models.json')).defaultMode, 'preview');
});

test('choosing the environment key keeps stored keys but stops using them, and can be undone', async () => {
  const dataDir = makeTempDataDir('settings-fallback');
  process.env.TAILOR_DATA_DIR = dataDir;
  clearProviderEnv();
  process.env.YOUBOT_API_KEY = 'youbot-env-secret';
  const config = loadFresh('../dist/config/aiModelConfig');

  await config.updateAppSettings({
    apiKeys: { youbot: { add: [{ clientId: 'c1', name: 'Stored', value: 'youbot-stored-secret' }], activeKeyId: 'c1' } },
  });
  assert.equal(await config.getProviderApiKey('youbot'), 'youbot-stored-secret');

  const viaEnv = await config.updateAppSettings({ apiKeys: { youbot: { activeKeyId: '', useEnvironmentFallback: true } } });
  assert.equal(viaEnv.apiKeys.youbot.activeSource, 'environment');
  assert.equal(viaEnv.apiKeys.youbot.entries.length, 1, 'the stored key is kept for later');
  assert.equal(await config.getProviderApiKey('youbot'), 'youbot-env-secret');

  // The choice survives a fresh read of the file.
  const reread = await loadFresh('../dist/config/aiModelConfig').getAdminAppSettings();
  assert.equal(reread.apiKeys.youbot.activeSource, 'environment');
  assert.equal(reread.apiKeys.youbot.entries.length, 1);

  // ...and switching back to the stored key works.
  const storedId = reread.apiKeys.youbot.entries[0].id;
  const back = await config.updateAppSettings({ apiKeys: { youbot: { activeKeyId: storedId } } });
  assert.equal(back.apiKeys.youbot.activeSource, 'stored');
  assert.equal(await config.getProviderApiKey('youbot'), 'youbot-stored-secret');
  process.env.YOUBOT_API_KEY = '';
});

test('app settings preserve at least one enabled provider and can fall back to environment keys', async () => {
  const dataDir = makeTempDataDir('settings-env');
  process.env.TAILOR_DATA_DIR = dataDir;
  clearProviderEnv();
  process.env.OPENAI_API_KEY = 'openai-env-secret';
  process.env.YOUBOT_API_KEY = 'youbot-env-secret';
  const config = loadFresh('../dist/config/aiModelConfig');

  await assert.rejects(
    () => config.updateAppSettings({
      enabledProviders: { openai: false, claude: false, openrouter: false, youbot: false, cheapai: false },
    }),
    /At least one AI model must remain enabled/
  );

  assert.equal(await config.getProviderApiKey('openai'), 'openai-env-secret');
  assert.equal(await config.getProviderApiKey('youbot'), 'youbot-env-secret');
  const admin = await config.getAdminAppSettings();
  assert.equal(admin.apiKeys.openai.activeSource, 'environment');
  assert.equal(admin.apiKeys.youbot.activeSource, 'environment');
  assert.deepEqual(
    Object.fromEntries(admin.providers.map((provider) => [provider.id, provider.configured])),
    { openai: true, claude: false, openrouter: false, youbot: true, cheapai: false }
  );

  const settings = await config.getAIModelSettings();
  assert.equal(config.isProviderEnabled('youbot', settings), true);
  assert.equal(config.getDefaultEnabledProvider(settings), 'openai');
  assert.equal(config.getDefaultEnabledProvider({ ...settings, defaultProviderId: 'youbot' }), 'youbot');
  assert.equal(
    config.getDefaultEnabledProvider({
      enabledProviders: { ...settings.enabledProviders, openai: false },
      defaultProviderId: 'openai',
    }),
    'claude'
  );
  clearProviderEnv();
});

test('generated path helpers read output settings from the JSON config', async () => {
  const dataDir = makeTempDataDir('generated-path');
  const outputDir = path.join(dataDir, 'output');
  process.env.TAILOR_DATA_DIR = dataDir;
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{profile name}}/{{company name}}/{{job title}}',
  });

  const result = await generatedPath.getGeneratedOutputPath(
    { name: 'Jane Doe' },
    'Acme Inc',
    'Senior Engineer'
  );

  assert.equal(result.relativeBase, 'jane_doe/acme_inc/senior_engineer');
  assert.equal(result.absoluteDir, path.join(outputDir, 'jane_doe', 'acme_inc', 'senior_engineer'));
  assert.equal(result.profileSlug, 'jane_doe');
  assert.equal(result.companyFolderName, 'acme_inc');
  assert.equal(result.roleSlug, 'senior_engineer');
});

test('generated path helpers build title dash filename segments with common tech acronyms', async () => {
  const dataDir = makeTempDataDir('generated-path-acronyms');
  const outputDir = path.join(dataDir, 'output');
  process.env.TAILOR_DATA_DIR = dataDir;
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');

  await config.updateAppSettings({
    outputBaseDir: outputDir,
    outputPathTemplate: '/{{profile name}}/{{company name}}/{{job title}}',
  });

  const result = await generatedPath.getGeneratedOutputPath(
    { name: 'kyle escobar' },
    'Square',
    'senior infrastructure engineer & ai/ml engineer'
  );

  assert.equal(result.profileFileSegment, 'Kyle-Escobar');
  assert.equal(result.roleFileSegment, 'Senior-Infrastructure-Engineer-AI-ML-Engineer');
  assert.equal(
    generatedPath.buildGeneratedArtifactFilename(result, 'resume', 'pdf'),
    'Kyle-Escobar-Resume-Senior-Infrastructure-Engineer-AI-ML-Engineer.pdf'
  );
  assert.equal(
    generatedPath.buildGeneratedArtifactFilename(result, 'coverletter', 'pdf'),
    'Kyle-Escobar-Cover-Letter-Senior-Infrastructure-Engineer-AI-ML-Engineer.pdf'
  );
});

test('a batch can pin the output date so later builds and resumes land in the same folder', async () => {
  const dataDir = makeTempDataDir('generated-date');
  const outputDir = path.join(dataDir, 'output');
  process.env.TAILOR_DATA_DIR = dataDir;
  const config = loadFresh('../dist/config/aiModelConfig');
  const generatedPath = loadFresh('../dist/utils/generatedPath');
  await config.updateAppSettings({ outputBaseDir: outputDir });

  const profile = { id: 'p1', name: 'Jane Doe', experience: [] };
  const pinned = await generatedPath.getGeneratedOutputPath(profile, 'Acme', 'Engineer', { outputDate: '2026-01-02' });
  assert.equal(pinned.outputDate, '2026-01-02');
  assert.ok(/2026[-_]01[-_]02/.test(pinned.relativeBase), pinned.relativeBase);
  const today = await generatedPath.getGeneratedOutputPath(profile, 'Acme', 'Engineer');
  assert.match(today.outputDate, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);

  assert.equal(generatedPath.normalizeOutputDate('2026_01_02'), '2026-01-02');
  assert.equal(generatedPath.normalizeOutputDate(' 2026-01-02 '), '2026-01-02');
  assert.equal(generatedPath.normalizeOutputDate('tomorrow'), undefined);
  assert.equal(generatedPath.normalizeOutputDate(undefined), undefined);
});
