import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../lib/http.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { createInvite, listInvites, revokeInvite } from '../services/accounts.js';

export const invitesRouter = Router();
invitesRouter.use(requireAuth, requireAdmin);

const createSchema = z.object({
  note: z.string().trim().max(120).optional(),
});

invitesRouter.get('/', (_req, res) => {
  res.json({ invites: listInvites() });
});

invitesRouter.post('/', (req, res) => {
  const { note } = parse(createSchema, req.body ?? {});
  const invite = createInvite(req.account!.id, note);
  res.status(201).json({ invite: { id: invite.id, code: invite.code, note: invite.note } });
});

invitesRouter.post('/:id/revoke', (req, res) => {
  if (!revokeInvite(req.params.id)) {
    throw new HttpError(400, 'Invite cannot be revoked (already used or not found)');
  }
  res.status(204).end();
});
