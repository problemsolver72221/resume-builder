'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  promptsApi,
  PromptPreviewResult,
  PromptRecord,
  PromptResponseFormat,
  PromptSummary,
  PromptValidation,
  PromptVariableDefinition,
} from '@/lib/api';

type PromptDraft = {
  id?: string;
  name: string;
  description: string;
  content: string;
  responseFormat: PromptResponseFormat;
  allowedVariables: PromptVariableDefinition[];
  isBuiltIn: boolean;
  usage?: string;
  createdAt?: string;
  updatedAt?: string;
};

function emptyValidation(): PromptValidation {
  return {
    usedVariables: [],
    unknownVariables: [],
  };
}

function makeDraft(record: PromptRecord): PromptDraft {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    content: record.content,
    responseFormat: record.responseFormat,
    allowedVariables: record.allowedVariables.map((variable) => ({ ...variable })),
    isBuiltIn: record.isBuiltIn,
    usage: record.usage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function makeBlankDraft(): PromptDraft {
  return {
    name: '',
    description: '',
    content: '',
    responseFormat: 'json',
    allowedVariables: [],
    isBuiltIn: false,
  };
}

function makeDuplicateDraft(draft: PromptDraft): PromptDraft {
  return {
    ...draft,
    id: undefined,
    name: draft.name ? `${draft.name} Copy` : 'New Prompt',
    isBuiltIn: false,
    createdAt: undefined,
    updatedAt: undefined,
  };
}

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [validation, setValidation] = useState<PromptValidation>(emptyValidation());
  const [preview, setPreview] = useState<PromptPreviewResult | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingPrompt, setIsLoadingPrompt] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const openPrompt = useCallback(async (id: string) => {
    setIsLoadingPrompt(true);
    setError('');
    setStatus('');
    try {
      const record = await promptsApi.getById(id);
      setDraft(makeDraft(record));
      setSelectedId(record.id);
      setValidation(record.validation);
      setPreview(null);
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompt');
    } finally {
      setIsLoadingPrompt(false);
    }
  }, []);

  const refreshPrompts = useCallback(async (preferredId?: string | null) => {
    setIsLoadingList(true);
    setError('');
    try {
      const data = await promptsApi.getAll();
      setPrompts(data);

      const nextId =
        preferredId && data.some((prompt) => prompt.id === preferredId)
          ? preferredId
          : data[0]?.id ?? null;

      if (nextId) {
        await openPrompt(nextId);
      } else {
        setDraft(makeBlankDraft());
        setSelectedId(null);
        setValidation(emptyValidation());
        setPreview(null);
        setIsDirty(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prompts');
    } finally {
      setIsLoadingList(false);
    }
  }, [openPrompt]);

  useEffect(() => {
    void refreshPrompts();
  }, [refreshPrompts]);

  const confirmDiscard = (): boolean => {
    if (!isDirty) return true;
    return window.confirm('Discard unsaved changes?');
  };

  const handleSelectPrompt = async (id: string) => {
    if (id === selectedId) return;
    if (!confirmDiscard()) return;
    await openPrompt(id);
  };

  const handleNewBlank = () => {
    if (!confirmDiscard()) return;
    setDraft(makeBlankDraft());
    setSelectedId(null);
    setValidation(emptyValidation());
    setPreview(null);
    setError('');
    setStatus('Creating a new custom prompt.');
    setIsDirty(false);
  };

  const handleDuplicate = () => {
    if (!draft) return;
    setDraft(makeDuplicateDraft(draft));
    setSelectedId(null);
    setValidation(emptyValidation());
    setPreview(null);
    setError('');
    setStatus('Duplicated into a new custom prompt draft.');
    setIsDirty(true);
  };

  const updateDraft = (updater: (current: PromptDraft) => PromptDraft) => {
    setDraft((current) => {
      if (!current) return current;
      return updater(current);
    });
    setIsDirty(true);
    setStatus('');
    setError('');
  };

  const handleValidate = async () => {
    if (!draft) return;
    setIsValidating(true);
    setError('');
    setStatus('');
    try {
      const nextValidation = await promptsApi.validateDraft({
        id: draft.id,
        content: draft.content,
        allowedVariables: draft.isBuiltIn ? undefined : draft.allowedVariables,
      });
      setValidation(nextValidation);
      setStatus('Validation complete.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate prompt');
    } finally {
      setIsValidating(false);
    }
  };

  const handlePreview = async () => {
    if (!draft) return;
    setIsPreviewing(true);
    setError('');
    setStatus('');
    try {
      const nextPreview = await promptsApi.previewDraft({
        id: draft.id,
        content: draft.content,
        allowedVariables: draft.isBuiltIn ? undefined : draft.allowedVariables,
      });
      setPreview(nextPreview);
      setValidation(nextPreview.validation);
      setStatus('Preview generated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview prompt');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setIsSaving(true);
    setError('');
    setStatus('');
    try {
      const payload = {
        name: draft.name,
        description: draft.description,
        content: draft.content,
        responseFormat: draft.responseFormat,
        allowedVariables: draft.allowedVariables,
      };

      const saved = draft.id
        ? await promptsApi.update(draft.id, payload)
        : await promptsApi.create(payload);

      await refreshPrompts(saved.id);
      setPreview(null);
      setStatus(draft.id ? 'Prompt updated.' : 'Prompt created.');
      setValidation(saved.validation);
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save prompt');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!draft?.id || draft.isBuiltIn) return;
    if (!window.confirm(`Delete "${draft.name}"?`)) return;

    setError('');
    setStatus('');
    try {
      await promptsApi.delete(draft.id);
      await refreshPrompts();
      setStatus('Prompt deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete prompt');
    }
  };

  const addVariable = () => {
    updateDraft((current) => ({
      ...current,
      allowedVariables: [
        ...current.allowedVariables,
        { name: '', description: '', sampleValue: '' },
      ],
    }));
  };

  const updateVariable = (
    index: number,
    field: keyof PromptVariableDefinition,
    value: string
  ) => {
    updateDraft((current) => ({
      ...current,
      allowedVariables: current.allowedVariables.map((variable, variableIndex) =>
        variableIndex === index ? { ...variable, [field]: value } : variable
      ),
    }));
  };

  const removeVariable = (index: number) => {
    updateDraft((current) => ({
      ...current,
      allowedVariables: current.allowedVariables.filter((_, variableIndex) => variableIndex !== index),
    }));
  };

  if (isLoadingList && !draft) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Prompt Library</h1>
          <p className="text-sm text-gray-600 mt-1">
            Built-in prompts are live application prompts. Custom prompts are stored drafts until wired into a runtime flow.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleNewBlank}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
          >
            New Blank Prompt
          </button>
          <button
            onClick={handleDuplicate}
            disabled={!draft}
            className="px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 font-medium disabled:opacity-50"
          >
            Duplicate Current
          </button>
          <button
            onClick={() => void refreshPrompts(selectedId)}
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium"
          >
            Reload
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {status && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {status}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Prompts</h2>
            {isLoadingList && <span className="text-xs text-gray-500">Refreshing...</span>}
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {prompts.map((prompt) => (
              <button
                key={prompt.id}
                onClick={() => void handleSelectPrompt(prompt.id)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 ${
                  selectedId === prompt.id ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">{prompt.name}</div>
                    <div className="text-xs text-gray-500 mt-1">{prompt.id}</div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      prompt.isBuiltIn
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {prompt.isBuiltIn ? 'Live' : 'Custom'}
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-2 line-clamp-3">{prompt.description}</p>
              </button>
            ))}
          </div>
        </aside>

        <section className="bg-white rounded-xl border border-gray-200">
          {!draft ? (
            <div className="p-8 text-sm text-gray-500">Select or create a prompt to start editing.</div>
          ) : (
            <div className="p-6 space-y-6">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-semibold text-gray-900">
                      {draft.id ? draft.name : 'New Custom Prompt'}
                    </h2>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        draft.isBuiltIn
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {draft.isBuiltIn ? 'Built-in' : 'Custom'}
                    </span>
                    <span className="rounded-full px-2.5 py-1 text-xs font-medium bg-amber-100 text-amber-700">
                      {draft.responseFormat.toUpperCase()}
                    </span>
                    {isDirty && (
                      <span className="rounded-full px-2.5 py-1 text-xs font-medium bg-orange-100 text-orange-700">
                        Unsaved
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-2">
                    {draft.id ? `ID: ${draft.id}` : 'ID will be generated on save'}
                  </div>
                  {draft.usage && (
                    <div className="text-sm text-gray-600 mt-2">{draft.usage}</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleValidate}
                    disabled={isValidating || isSaving || isLoadingPrompt}
                    className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium disabled:opacity-50"
                  >
                    {isValidating ? 'Validating...' : 'Validate'}
                  </button>
                  <button
                    onClick={handlePreview}
                    disabled={isPreviewing || isSaving || isLoadingPrompt}
                    className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 font-medium disabled:opacity-50"
                  >
                    {isPreviewing ? 'Previewing...' : 'Preview'}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={isSaving || isLoadingPrompt}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium disabled:opacity-50"
                  >
                    {isSaving ? 'Saving...' : 'Save Prompt'}
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={!draft.id || draft.isBuiltIn || isSaving}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 font-medium disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {isLoadingPrompt && (
                <div className="text-sm text-gray-500">Loading prompt...</div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={draft.name}
                    disabled={draft.isBuiltIn}
                    onChange={(event) =>
                      updateDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Response Format</label>
                  <select
                    value={draft.responseFormat}
                    disabled={draft.isBuiltIn}
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        responseFormat: event.target.value as PromptResponseFormat,
                      }))
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100"
                  >
                    <option value="json">JSON</option>
                    <option value="text">Text</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={draft.description}
                  disabled={draft.isBuiltIn}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100"
                />
              </div>

              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                Use <code className="rounded bg-white px-1 py-0.5">[[variableName]]</code> placeholders inside prompt text.
                Built-in prompts have backend-managed variable sets. Custom prompts can define their own variable list below.
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Prompt Content</h3>
                  <div className="text-xs text-gray-500">Created: {formatDate(draft.createdAt)} | Updated: {formatDate(draft.updatedAt)}</div>
                </div>
                <textarea
                  value={draft.content}
                  onChange={(event) =>
                    updateDraft((current) => ({ ...current, content: event.target.value }))
                  }
                  className="w-full min-h-[720px] rounded-xl border border-gray-300 px-4 py-3 font-mono text-sm"
                  spellCheck={false}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Variables</h3>
                  {!draft.isBuiltIn && (
                    <button
                      onClick={addVariable}
                      className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                    >
                      Add Variable
                    </button>
                  )}
                </div>

                {draft.allowedVariables.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 px-4 py-3 text-sm text-gray-500">
                    No variables defined.
                  </div>
                )}

                <div className="space-y-3">
                  {draft.allowedVariables.map((variable, index) => (
                    <div key={`${variable.name}-${index}`} className="rounded-lg border border-gray-200 p-4">
                      {draft.isBuiltIn ? (
                        <div className="space-y-2">
                          <div className="font-mono text-sm text-gray-900">{variable.name}</div>
                          {variable.description && (
                            <div className="text-sm text-gray-600">{variable.description}</div>
                          )}
                          {variable.sampleValue && (
                            <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600 whitespace-pre-wrap">
                              {variable.sampleValue}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-start">
                          <input
                            type="text"
                            value={variable.name}
                            onChange={(event) => updateVariable(index, 'name', event.target.value)}
                            placeholder="variableName"
                            className="rounded-lg border border-gray-300 px-3 py-2"
                          />
                          <input
                            type="text"
                            value={variable.description ?? ''}
                            onChange={(event) => updateVariable(index, 'description', event.target.value)}
                            placeholder="Description"
                            className="rounded-lg border border-gray-300 px-3 py-2"
                          />
                          <input
                            type="text"
                            value={variable.sampleValue ?? ''}
                            onChange={(event) => updateVariable(index, 'sampleValue', event.target.value)}
                            placeholder="Sample value for preview"
                            className="rounded-lg border border-gray-300 px-3 py-2"
                          />
                          <button
                            onClick={() => removeVariable(index)}
                            className="px-3 py-2 bg-red-50 text-red-700 rounded-lg hover:bg-red-100"
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="rounded-xl border border-gray-200 p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Validation</h3>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">Used Variables</div>
                    <div className="flex flex-wrap gap-2">
                      {validation.usedVariables.length === 0 ? (
                        <span className="text-sm text-gray-500">No placeholders detected.</span>
                      ) : (
                        validation.usedVariables.map((name) => (
                          <span key={name} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                            {name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">Unknown Variables</div>
                    <div className="flex flex-wrap gap-2">
                      {validation.unknownVariables.length === 0 ? (
                        <span className="text-sm text-emerald-700">None.</span>
                      ) : (
                        validation.unknownVariables.map((name) => (
                          <span key={name} className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">
                            {name}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">Rendered Preview</h3>
                    {preview && (
                      <span className="text-xs text-gray-500">
                        {Object.keys(preview.sampleValues).length} sample values injected
                      </span>
                    )}
                  </div>
                  <div className="min-h-[220px] rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 whitespace-pre-wrap overflow-auto">
                    {preview?.renderedContent ?? 'Run Preview to render this prompt with sample values.'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
