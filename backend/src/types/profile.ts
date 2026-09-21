/**
 * Profile shapes live in shared/types/profile.d.ts so the frontend reads the same contract.
 * This module re-exports them, which keeps every existing `from '../types/profile'` import
 * working and leaves one place to add backend-only extensions if they are ever needed.
 */
export type {
  Certification,
  Contact,
  CreateProfileDTO,
  Education,
  Experience,
  Group,
  Profile,
  Strength,
} from '@shared/types/profile';
