/**
 * The real BuildPort: the batch model's three calls, wired to the HTTP client.
 *
 * This is the only place the model touches the network. Tests substitute a fake object of
 * the same shape, which is what makes the batch loop verifiable without a backend.
 */
import { resumeApi } from '@/lib/api';
import type { BuildPort } from './types';

export const buildPort: BuildPort = {
  checkExisting: (input) => resumeApi.existing(input),
  analyze: (jobDescription, model) => resumeApi.analyze(jobDescription, model),
  generate: (input) => resumeApi.generate(input),
};
