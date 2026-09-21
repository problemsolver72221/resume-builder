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

export interface PromptCreateInput {
  name: string;
  description?: string;
  content: string;
  responseFormat?: PromptResponseFormat;
  allowedVariables?: PromptVariableDefinition[];
}

export interface PromptUpdateInput {
  name?: string;
  description?: string;
  content: string;
  responseFormat?: PromptResponseFormat;
  allowedVariables?: PromptVariableDefinition[];
}

export interface PromptPreviewInput {
  id?: string;
  content?: string;
  allowedVariables?: PromptVariableDefinition[];
  sampleValues?: Record<string, string>;
}

export interface PromptPreviewResult {
  renderedContent: string;
  sampleValues: Record<string, string>;
  validation: PromptValidation;
}
