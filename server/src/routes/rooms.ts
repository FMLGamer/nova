import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { parse } from '../lib/http.js';
import { createRoom, getRoom } from '../services/rooms.js';

export const roomsRouter = Router();
roomsRouter.use(requireAuth);

const targetSchema = z.object({
  mediaId: z.string().max(200),
  mediaType: z.string().max(20),
  itemKey: z.string().max(200),
  title: z.string().max(300),
  poster: z.string().max(2000).nullable(),
  backdrop: z.string().max(2000).nullable(),
  season: z.number().int().nullable(),
  episode: z.number().int().nullable(),
  path: z.string().startsWith('/stream/').max(2000),
  src: z.string().max(2000),
});

roomsRouter.post('/', (req, res) => {
  const { target } = parse(z.object({ target: targetSchema }), req.body);
  res.status(201).json(createRoom(req.account!.id, target));
});

roomsRouter.get('/:code', (req, res) => {
  res.json({ room: getRoom(req.params.code) });
});
