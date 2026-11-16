import crypto from 'node:crypto';
import { db } from '../db/index.js';
import type { AccountRow, AccountDTO, InviteRow, InviteDTO } from '../types.js';

export function accountToDTO(a: AccountRow): AccountDTO {
  return { id: a.id, username: a.username, isAdmin: a.is_admin === 1, createdAt: a.created_at };
}

export function getAccountById(id: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
}

export function getAccountByUsername(username: string): AccountRow | undefined {
  return db.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE').get(username) as AccountRow | undefined;
}

export function countAccounts(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
}

export function createAccount(opts: {
  username: string;
  passwordHash: string;
  isAdmin?: boolean;
  inviteId?: string | null;
}): AccountRow {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO accounts (id, username, password_hash, is_admin, invite_id) VALUES (?, ?, ?, ?, ?)',
  ).run(id, opts.username, opts.passwordHash, opts.isAdmin ? 1 : 0, opts.inviteId ?? null);
  return getAccountById(id)!;
}

// --- Invite keys ---------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

export function generateInviteCode(): string {
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (i % 4 === 3 && i !== 11) out += '-';
  }
  return out;
}

export function createInvite(createdBy: string, note?: string): InviteRow {
  const id = crypto.randomUUID();
  // Extremely unlikely to collide, but retry once on the UNIQUE(code) constraint.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      db.prepare('INSERT INTO invite_keys (id, code, note, created_by) VALUES (?, ?, ?, ?)').run(
        id,
        code,
        note?.trim() || null,
        createdBy,
      );
      return db.prepare('SELECT * FROM invite_keys WHERE id = ?').get(id) as InviteRow;
    } catch {
      /* retry with a fresh code */
    }
  }
  throw new Error('Failed to generate a unique invite code');
}

export function getInviteByCode(code: string): InviteRow | undefined {
  return db.prepare('SELECT * FROM invite_keys WHERE code = ?').get(code.trim().toUpperCase()) as
    | InviteRow
    | undefined;
}

export function markInviteUsed(inviteId: string, accountId: string): void {
  db.prepare("UPDATE invite_keys SET used_by = ?, used_at = datetime('now') WHERE id = ?").run(
    accountId,
    inviteId,
  );
}

export function revokeInvite(id: string): boolean {
  const info = db.prepare('UPDATE invite_keys SET revoked = 1 WHERE id = ? AND used_by IS NULL').run(id);
  return info.changes > 0;
}

function inviteStatus(i: InviteRow): InviteDTO['status'] {
  if (i.used_by) return 'used';
  if (i.revoked) return 'revoked';
  return 'available';
}

export function listInvites(): InviteDTO[] {
  const rows = db
    .prepare(
      `SELECT k.*, a.username AS used_by_username
       FROM invite_keys k
       LEFT JOIN accounts a ON a.id = k.used_by
       ORDER BY k.created_at DESC`,
    )
    .all() as (InviteRow & { used_by_username: string | null })[];
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    note: r.note,
    createdAt: r.created_at,
    usedByUsername: r.used_by_username,
    usedAt: r.used_at,
    revoked: r.revoked === 1,
    status: inviteStatus(r),
  }));
}
