'use strict';
// Discord Rich Presence over Discord's local IPC socket: no SDK and no network, and nothing happens
// unless Discord is running on this computer.
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function socketPaths() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  // Plain, Flatpak and Snap installs each put the socket somewhere else.
  const dirs = [base, path.join(base, 'app', 'com.discordapp.Discord'), path.join(base, 'snap.discord')];
  return dirs.flatMap((d) => Array.from({ length: 10 }, (_, i) => path.join(d, `discord-ipc-${i}`)));
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function open(p) {
  return new Promise((resolve) => {
    const s = net.createConnection(p);
    s.once('connect', () => resolve(s));
    s.once('error', () => resolve(null));
  });
}

class DiscordPresence {
  constructor(clientId) {
    this.clientId = clientId;
    this.sock = null;
    this.connecting = null;
    this.retryAt = 0;
  }

  async connect() {
    if (this.sock) return true;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAt) return false;
    this.connecting = (async () => {
      for (const p of socketPaths()) {
        const sock = await open(p);
        if (sock && (await this.handshake(sock))) return true;
        sock?.destroy();
      }
      // Discord isn't running: look again in a while rather than on every update.
      this.retryAt = Date.now() + 30_000;
      return false;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  handshake(sock) {
    return new Promise((resolve) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => resolve(false), 4000);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const op = buf.readInt32LE(0);
          const len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          let body = {};
          try {
            body = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
          } catch {
            /* ignore a malformed frame */
          }
          buf = buf.subarray(8 + len);
          if (op === OP.PING) sock.write(encode(OP.PONG, body));
          else if (op === OP.CLOSE) sock.destroy();
          else if (body.evt === 'READY') {
            clearTimeout(timer);
            this.sock = sock;
            resolve(true);
          }
        }
      });
      sock.on('error', () => undefined);
      sock.on('close', () => {
        clearTimeout(timer);
        if (this.sock === sock) this.sock = null;
        resolve(false);
      });
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
  }

  async set(activity) {
    if (!(await this.connect())) return;
    this.sock?.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activity ?? undefined }, nonce: crypto.randomUUID() }));
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
  }
}

const text = (v, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const time = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/** What the page sends -> a Discord activity. Only https artwork: Discord can't fetch this computer's URLs. */
function toActivity(a) {
  if (!a || typeof a !== 'object') return null;
  const details = text(a.title);
  if (!details) return null;
  const image = typeof a.image === 'string' && /^https:\/\//.test(a.image) && a.image.length <= 256 ? a.image : undefined;
  return {
    type: a.kind === 'reading' ? 0 : a.kind === 'listening' ? 2 : 3,
    details,
    state: text(a.paused ? `${a.subtitle ? `${a.subtitle} · ` : ''}Paused` : a.subtitle),
    timestamps: a.paused ? undefined : time(a.start) ? { start: time(a.start), end: time(a.end) } : undefined,
    assets: image ? { large_image: image, large_text: details } : undefined,
    instance: false,
  };
}

module.exports = { DiscordPresence, toActivity };
