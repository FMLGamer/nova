import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { COOKIE_NAME } from '../config.js';
import { db } from '../db/index.js';
import { verifySession } from '../auth/tokens.js';
import { devAuthAccount } from '../auth/middleware.js';
import { randomToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';

export interface RoomTarget {
  mediaId: string;
  mediaType: string;
  itemKey: string;
  title: string;
  poster: string | null;
  backdrop: string | null;
  season: number | null;
  episode: number | null;
  /** Stream path every member plays, e.g. /stream/t/<hash>/<idx>. */
  path: string;
  src: string;
}

interface PlayState {
  playing: boolean;
  position: number;
  rate: number;
  /** Server clock (ms) when `position` was true. */
  at: number;
}

interface Member {
  id: string;
  accountId: string;
  name: string;
  avatar: string | null;
  ws: WebSocket;
  buffering: boolean;
}

interface ChatMessage {
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
  kind: 'chat' | 'system' | 'react';
}

interface Room {
  code: string;
  hostAccountId: string;
  target: RoomTarget;
  state: PlayState;
  members: Map<string, Member>;
  chat: ChatMessage[];
  createdAt: number;
  emptySince: number | null;
}

const rooms = new Map<string, Room>();

function code(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of randomToken(8)) out += alphabet[b.charCodeAt(0) % alphabet.length];
  return out.slice(0, 6);
}

export function createRoom(hostAccountId: string, target: RoomTarget): { code: string } {
  let c = code();
  while (rooms.has(c)) c = code();
  rooms.set(c, {
    code: c,
    hostAccountId,
    target,
    state: { playing: false, position: 0, rate: 1, at: Date.now() },
    members: new Map(),
    chat: [],
    createdAt: Date.now(),
    emptySince: Date.now(),
  });
  return { code: c };
}

function publicRoom(r: Room) {
  return {
    code: r.code,
    target: r.target,
    state: r.state,
    hostAccountId: r.hostAccountId,
    members: [...r.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, buffering: m.buffering, host: m.accountId === r.hostAccountId })),
    chat: r.chat.slice(-60),
  };
}

export function getRoom(c: string) {
  const r = rooms.get(c.toUpperCase());
  if (!r) throw new HttpError(404, 'This watch room has ended');
  return publicRoom(r);
}

function broadcast(r: Room, msg: unknown, except?: string): void {
  const data = JSON.stringify(msg);
  for (const m of r.members.values()) {
    if (m.id === except) continue;
    if (m.ws.readyState === m.ws.OPEN) m.ws.send(data);
  }
}

function system(r: Room, text: string): void {
  const msg: ChatMessage = { id: randomToken(6), from: 'system', name: 'Nova', text, at: Date.now(), kind: 'system' };
  r.chat.push(msg);
  broadcast(r, { t: 'chat', msg });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/** Handles `GET /ws/rooms/:code` upgrades (session cookie required). */
export function handleRoomUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const m = req.url?.match(/^\/ws\/rooms\/([A-Za-z0-9]{6})(?:\?(.*))?$/);
  if (!m) return false;
  const claims = verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME] ?? '');
  const accountId = claims?.sub ?? devAuthAccount()?.id;
  const room = rooms.get(m[1]!.toUpperCase());
  if (!accountId || !room) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }
  const params = new URLSearchParams(m[2] ?? '');
  const profileId = params.get('profile');
  const profile = profileId
    ? (db.prepare('SELECT name, avatar FROM profiles WHERE id = ? AND account_id = ?').get(profileId, accountId) as { name: string; avatar: string } | undefined)
    : undefined;
  const account = db.prepare('SELECT username FROM accounts WHERE id = ?').get(accountId) as { username: string } | undefined;
  wss.handleUpgrade(req, socket, head, (ws) => {
    const member: Member = {
      id: randomToken(6),
      accountId,
      name: profile?.name ?? account?.username ?? 'Guest',
      avatar: profile?.avatar ?? null,
      ws,
      buffering: false,
    };
    room.members.set(member.id, member);
    room.emptySince = null;
    ws.send(JSON.stringify({ t: 'welcome', you: member.id, now: Date.now(), room: publicRoom(room) }));
    broadcast(room, { t: 'members', members: publicRoom(room).members }, member.id);
    system(room, `${member.name} joined`);

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'ping':
          ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
          break;
        case 'state': {
          const position = Number(msg.position);
          if (!Number.isFinite(position) || position < 0) return;
          room.state = {
            playing: Boolean(msg.playing),
            position,
            rate: Math.min(4, Math.max(0.25, Number(msg.rate) || 1)),
            at: Date.now(),
          };
          broadcast(room, { t: 'state', state: room.state, by: member.id, byName: member.name, reason: String(msg.reason ?? '') }, member.id);
          break;
        }
        case 'buffering':
          member.buffering = Boolean(msg.on);
          broadcast(room, { t: 'members', members: publicRoom(room).members });
          break;
        case 'chat': {
          const text = String(msg.text ?? '').slice(0, 500).trim();
          if (!text) return;
          const c: ChatMessage = { id: randomToken(6), from: member.id, name: member.name, text, at: Date.now(), kind: 'chat' };
          room.chat.push(c);
          if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
          broadcast(room, { t: 'chat', msg: c });
          break;
        }
        case 'react': {
          const emoji = String(msg.emoji ?? '').slice(0, 8);
          if (emoji) broadcast(room, { t: 'react', emoji, name: member.name, from: member.id });
          break;
        }
        case 'target': {
          if (member.accountId !== room.hostAccountId) return;
          const t = msg.target as RoomTarget | undefined;
          if (!t?.path?.startsWith('/stream/')) return;
          room.target = t;
          room.state = { playing: false, position: 0, rate: 1, at: Date.now() };
          broadcast(room, { t: 'target', target: t, state: room.state });
          system(room, `${member.name} switched to ${t.title}`);
          break;
        }
      }
    });
    ws.on('close', () => {
      room.members.delete(member.id);
      broadcast(room, { t: 'members', members: publicRoom(room).members });
      system(room, `${member.name} left`);
      if (!room.members.size) room.emptySince = Date.now();
    });
  });
  return true;
}

// Rooms nobody is in for 30 minutes are closed.
setInterval(() => {
  const now = Date.now();
  for (const [c, r] of rooms) if (r.emptySince && now - r.emptySince > 30 * 60_000) rooms.delete(c);
}, 60_000).unref();
