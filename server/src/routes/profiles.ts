import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../lib/http.js';
import { requireAuth } from '../auth/middleware.js';
import {
  createProfile,
  deleteProfile,
  getPreferences,
  getProfileForAccount,
  listProfiles,
  profileToDTO,
  updatePreferences,
  updateProfile,
} from '../services/profiles.js';
import { getAccountSettings } from '../services/entitlements.js';

export const profilesRouter = Router();
profilesRouter.use(requireAuth);

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(24),
  avatar: z.string().trim().max(300000).optional(),
  isKids: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(24).optional(),
  avatar: z.string().trim().max(300000).optional(),
  isKids: z.boolean().optional(),
});

profilesRouter.get('/', (req, res) => {
  res.json({ profiles: listProfiles(req.account!.id).map(profileToDTO) });
});

profilesRouter.post('/', (req, res) => {
  const body = parse(createSchema, req.body);
  const account = req.account!;
  const { maxProfiles } = getAccountSettings(account.id, account.is_admin === 1);
  const profile = createProfile(account.id, { ...body, limit: maxProfiles });
  res.status(201).json({ profile: profileToDTO(profile) });
});

profilesRouter.patch('/:id', (req, res) => {
  const body = parse(updateSchema, req.body);
  const profile = updateProfile(req.params.id, req.account!.id, body);
  res.json({ profile: profileToDTO(profile) });
});

profilesRouter.delete('/:id', (req, res) => {
  deleteProfile(req.params.id, req.account!.id);
  res.status(204).end();
});

profilesRouter.get('/:id/preferences', (req, res) => {
  const profile = getProfileForAccount(req.params.id, req.account!.id);
  if (!profile) throw new HttpError(404, 'Profile not found');
  res.json({ preferences: getPreferences(profile.id) });
});

profilesRouter.put('/:id/preferences', (req, res) => {
  const profile = getProfileForAccount(req.params.id, req.account!.id);
  if (!profile) throw new HttpError(404, 'Profile not found');
  res.json({ preferences: updatePreferences(profile.id, req.body ?? {}) });
});
