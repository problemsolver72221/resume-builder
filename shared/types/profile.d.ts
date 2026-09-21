/**
 * A candidate profile as it is stored in backend/data/profiles/<id>.json.
 *
 * The backend is the source of truth here: these shapes describe what the writer persists,
 * so a field only belongs in this file once normalizeProfilePayload actually saves it.
 */

export interface Contact {
  phone: string;
  email: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location: string;
}

export interface Experience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
}

export interface Strength {
  title: string;
  description: string;
}

export interface Education {
  degree: string;
  institution: string;
  startDate: string;
  endDate: string;
  location: string;
  gpa?: string;
  achievements?: string[];
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
  expiryDate?: string;
  credentialId?: string;
}

export interface Profile {
  id: string;
  name: string;
  title: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  contact: Contact;
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  skills: string[];
  education: Education[];
  certifications?: Certification[];
  createdAt: string;
  updatedAt: string;
}

/** What a create or update request may send; everything absent keeps its stored value. */
export interface CreateProfileDTO {
  name?: string;
  title?: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  contact?: Partial<Contact>;
  summary?: string;
  experience?: Partial<Experience>[];
  strengths?: Partial<Strength>[];
  skills?: string[];
  education?: Partial<Education>[];
  certifications?: Certification[];
}

export interface Group {
  id: string;
  name: string;
  profileIds: string[];
  createdAt: string;
  updatedAt: string;
}
