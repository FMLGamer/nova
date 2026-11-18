import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireProfile } from '../auth/middleware.js';
import { asyncHandler } from '../lib/async.js';
import { HttpError, parse, publicUrl } from '../lib/http.js';
import {
  anilistAuthorizeUrl,
  connectAnilist,
  disconnect,
  discussions,
  getEntries,
  malAuthorizeUrl,
  malCallback,
  setEntries,
  thread,
  trackedLists,
  trackerStatus,
  trackWatched,
} from '../services/trackers.js';

export const trackersRouter = Router();

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07070b;color:#e8e6e3;font:16px system-ui,sans-serif}
div{max-width:420px;padding:24px;text-align:center}p{color:#a7a7b8}a{color:#fff}</style></head><body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// MyAnimeList sends the browser back here. It may be a different browser than the one signed in to
// Nova (the Windows app opens sign-ins in the default browser), so the signed `state` says who.
trackersRouter.get(
  '/mal/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (error || !code || !state) {
      res.status(400).send(page('Not connected', escape(error ? `MyAnimeList said: ${error}` : 'The sign-in did not finish. Try again from Nova.')));
      return;
    }
    try {
      await malCallback(code, state);
      res.send(page('MyAnimeList connected', 'You can close this tab and go back to Nova. Finished episodes now update your list.'));
    } catch (err) {
      res.status(400).send(page('Not connected', escape(err instanceof Error ? err.message : 'Something went wrong')));
    }
  }),
);

trackersRouter.use(requireAuth, requireProfile);

trackersRouter.get('/', (req, res) => {
  res.json({ ...trackerStatus(req.profile!.id), anilistAuthorizeUrl: anilistAuthorizeUrl(), malRedirectUri: `${publicUrl(req)}/api/trackers/mal/callback` });
});

trackersRouter.post(
  '/anilist',
  asyncHandler(async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(4000) }), req.body);
    await connectAnilist(req.profile!.id, token);
    res.json(trackerStatus(req.profile!.id));
  }),
);

trackersRouter.get('/mal/authorize', (req, res) => {
  res.json({ url: malAuthorizeUrl(req.profile!.id, `${publicUrl(req)}/api/trackers/mal/callback`) });
});

trackersRouter.delete('/:service', (req, res) => {
  const service = req.params.service;
  if (service !== 'anilist' && service !== 'mal') throw new HttpError(404, 'Unknown service');
  disconnect(req.profile!.id, service);
  res.json(trackerStatus(req.profile!.id));
});

trackersRouter.get(
  '/entry/:mediaId',
  asyncHandler(async (req, res) => {
    res.json(await getEntries(req.profile!.id, decodeURIComponent(req.params.mediaId)));
  }),
);

const entrySchema = z.object({
  status: z.enum(['watching', 'rewatching', 'completed', 'planning', 'paused', 'dropped']).optional(),
  progress: z.number().int().min(0).max(100000).optional(),
  score: z.number().min(0).max(10).nullable().optional(),
});

trackersRouter.put(
  '/entry/:mediaId',
  asyncHandler(async (req, res) => {
    const mediaId = decodeURIComponent(req.params.mediaId);
    await setEntries(req.profile!.id, mediaId, parse(entrySchema, req.body));
    res.json(await getEntries(req.profile!.id, mediaId));
  }),
);

trackersRouter.get(
  '/discussions/:mediaId',
  asyncHandler(async (req, res) => {
    const episode = Number(req.query.episode);
    if (!Number.isInteger(episode) || episode < 1) throw new HttpError(400, 'Which episode?');
    res.json({ discussions: await discussions(decodeURIComponent(req.params.mediaId), episode) });
  }),
);

trackersRouter.get(
  '/thread/:site/:id',
  asyncHandler(async (req, res) => {
    const site = req.params.site;
    const id = Number(req.params.id);
    if ((site !== 'anilist' && site !== 'mal') || !Number.isInteger(id) || id < 1) throw new HttpError(404, 'Unknown thread');
    const page = Math.min(200, Math.max(1, Number(req.query.page) || 1));
    res.json(await thread(site, id, page));
  }),
);

/** A chapter (or episode) finished somewhere Nova can't see the progress itself, e.g. the reader. */
trackersRouter.post(
  '/progress',
  asyncHandler(async (req, res) => {
    const { mediaId, progress } = parse(z.object({ mediaId: z.string().regex(/^(anime|manga):\d+$/), progress: z.number().int().min(1).max(100000) }), req.body);
    await trackWatched(req.profile!.id, mediaId, progress);
    res.json({ ok: true });
  }),
);

/** Every title on the connected anime (or ?kind=manga) lists (Library → Anime & manga). */
trackersRouter.get(
  '/lists',
  asyncHandler(async (req, res) => {
    res.json({ items: await trackedLists(req.profile!.id, req.query.kind === 'manga' ? 'manga' : 'anime') });
  }),
);

/** Anime ids the connected lists have on Watching / Rewatching (the schedule's filter). */
trackersRouter.get(
  '/watching',
  asyncHandler(async (req, res) => {
    const s = trackerStatus(req.profile!.id);
    if (!s.anilist.connected && !s.mal.connected) {
      res.json({ ids: [] });
      return;
    }
    const items = await trackedLists(req.profile!.id);
    res.json({ ids: items.filter((i) => i.status === 'watching' || i.status === 'rewatching').map((i) => i.mediaId) });
  }),
);
