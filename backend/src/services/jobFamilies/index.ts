/**
 * Public surface of the job-family module: the shared contract, the registry with its
 * resolver and role-term test, and the headline builder. Consumers import from here so
 * the file split behind it can change without touching the pipeline.
 */
export * from './types';
export * from './registry';
export * from './headline';
