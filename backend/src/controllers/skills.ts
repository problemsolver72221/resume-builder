import { Request, Response } from 'express';
import {
  SkillDatabaseError,
  addSkill,
  deleteSkill,
  isSkillType,
  readSkills,
  updateSkill,
} from '../database/skillsDatabase';
import { refreshSkillCaches } from '../services/claude';

type SkillBody = {
  type?: unknown;
  skill?: unknown;
  original?: unknown;
};

function parseSkillValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sendSkillError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof SkillDatabaseError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  console.error(fallbackMessage, error);
  res.status(500).json({ error: fallbackMessage });
}

function refreshCachesForType(_type: 'hard' | 'soft'): void {
  refreshSkillCaches();
}

export function listSkills(req: Request, res: Response): void {
  try {
    const { type } = req.query;
    if (!isSkillType(type)) {
      res.status(400).json({ error: 'Skill type is required' });
      return;
    }

    res.json({ skills: readSkills(type) });
  } catch (error) {
    sendSkillError(res, error, 'Failed to read skills');
  }
}

export function confirmSkill(req: Request, res: Response): void {
  try {
    const { type, skill } = req.body as SkillBody;
    if (!isSkillType(type) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type and value are required' });
      return;
    }

    const result = addSkill(type, parseSkillValue(skill));
    if (result.added) {
      refreshCachesForType(type);
    }

    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to confirm skill');
  }
}

export function createSkill(req: Request, res: Response): void {
  try {
    const { type, skill } = req.body as SkillBody;
    if (!isSkillType(type) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type and value are required' });
      return;
    }

    const result = addSkill(type, parseSkillValue(skill));
    if (result.added) {
      refreshCachesForType(type);
    }

    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to add skill');
  }
}

export function updateSkillHandler(req: Request, res: Response): void {
  try {
    const { type, original, skill } = req.body as SkillBody;
    if (!isSkillType(type) || !parseSkillValue(original) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type, original value, and new value are required' });
      return;
    }

    const result = updateSkill(type, parseSkillValue(original), parseSkillValue(skill));
    refreshCachesForType(type);
    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to update skill');
  }
}

export function deleteSkillHandler(req: Request, res: Response): void {
  try {
    const { type, skill } = req.body as SkillBody;
    if (!isSkillType(type) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type and value are required' });
      return;
    }

    const result = deleteSkill(type, parseSkillValue(skill));
    refreshCachesForType(type);
    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to delete skill');
  }
}
