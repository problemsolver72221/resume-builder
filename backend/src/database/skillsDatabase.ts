import fs from 'fs';
import path from 'path';

export type SkillType = 'hard' | 'soft';

export type SkillMutationResult = {
  skill: string;
  type: SkillType;
};

export type AddSkillResult = SkillMutationResult & {
  added: boolean;
};

export type UpdateSkillResult = SkillMutationResult & {
  updated: boolean;
};

export type DeleteSkillResult = SkillMutationResult & {
  deleted: boolean;
};

type SkillsStore = Record<SkillType, string[]>;

export class SkillDatabaseError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'SkillDatabaseError';
  }
}

const DATA_DIR = process.env.TAILOR_DATA_DIR
  ? path.resolve(process.env.TAILOR_DATA_DIR)
  : path.join(__dirname, '../../data');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const SKILLS_FILE = path.join(SKILLS_DIR, 'skills.json');

function cleanSkill(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSkillValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSkillList(input: unknown): string[] {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const skills: string[] = [];

  for (const item of source) {
    const skill = cleanSkill(item);
    if (!skill) continue;

    const key = normalizeSkillValue(skill);
    if (seen.has(key)) continue;

    seen.add(key);
    skills.push(skill);
  }

  return skills.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function normalizeStore(input: unknown): SkillsStore {
  const source = typeof input === 'object' && input !== null
    ? input as Partial<Record<SkillType, unknown>>
    : {};

  return {
    hard: normalizeSkillList(source.hard),
    soft: normalizeSkillList(source.soft),
  };
}

function ensureSkillsFile(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });

  if (!fs.existsSync(SKILLS_FILE)) {
    writeStore({ hard: [], soft: [] });
  }
}

function readStore(): SkillsStore {
  ensureSkillsFile();

  try {
    const parsed = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8')) as unknown;
    return normalizeStore(parsed);
  } catch {
    return { hard: [], soft: [] };
  }
}

function writeStore(store: SkillsStore): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(SKILLS_FILE, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, 'utf8');
}

function findSkillIndex(skills: string[], skill: string): number {
  const normalized = normalizeSkillValue(skill);
  return skills.findIndex((item) => normalizeSkillValue(item) === normalized);
}

export function ensureSkillsDatabase(): void {
  ensureSkillsFile();
}

export function isSkillType(value: unknown): value is SkillType {
  return value === 'hard' || value === 'soft';
}

export function readSkills(type: SkillType): string[] {
  return readStore()[type];
}

export function addSkill(type: SkillType, skill: string): AddSkillResult {
  const cleaned = cleanSkill(skill);
  if (!cleaned) {
    throw new SkillDatabaseError('Skill type and value are required', 400);
  }

  const store = readStore();
  if (findSkillIndex(store[type], cleaned) !== -1) {
    return { added: false, skill: cleaned, type };
  }

  store[type].push(cleaned);
  writeStore(store);

  return { added: true, skill: cleaned, type };
}

export function updateSkill(type: SkillType, original: string, skill: string): UpdateSkillResult {
  const cleanedOriginal = cleanSkill(original);
  const cleaned = cleanSkill(skill);
  if (!cleanedOriginal || !cleaned) {
    throw new SkillDatabaseError('Skill type, original value, and new value are required', 400);
  }

  const store = readStore();
  const originalIndex = findSkillIndex(store[type], cleanedOriginal);
  if (originalIndex === -1) {
    throw new SkillDatabaseError('Skill not found', 404);
  }

  const duplicateIndex = findSkillIndex(store[type], cleaned);
  if (duplicateIndex !== -1 && duplicateIndex !== originalIndex) {
    throw new SkillDatabaseError('Skill already exists', 409);
  }

  store[type][originalIndex] = cleaned;
  writeStore(store);

  return { updated: true, skill: cleaned, type };
}

export function deleteSkill(type: SkillType, skill: string): DeleteSkillResult {
  const cleaned = cleanSkill(skill);
  if (!cleaned) {
    throw new SkillDatabaseError('Skill type and value are required', 400);
  }

  const store = readStore();
  const index = findSkillIndex(store[type], cleaned);
  if (index === -1) {
    throw new SkillDatabaseError('Skill not found', 404);
  }

  store[type].splice(index, 1);
  writeStore(store);

  return { deleted: true, skill: cleaned, type };
}
