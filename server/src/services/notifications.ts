import { db } from '../db/index.js';
import { newId } from '../lib/crypto.js';

export interface NotificationInput {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export function notify(accountId: string, n: NotificationInput): void {
  db.prepare('INSERT INTO notifications (id, account_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?, ?)').run(
    newId(),
    accountId,
    n.kind,
    n.title,
    n.body ?? null,
    n.link ?? null,
  );
}

export function notifyAdmins(n: NotificationInput): void {
  const admins = db.prepare('SELECT id FROM accounts WHERE is_admin = 1').all() as { id: string }[];
  for (const a of admins) notify(a.id, n);
}

export function listNotifications(accountId: string): NotificationDTO[] {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE account_id = ? ORDER BY created_at DESC LIMIT 50')
    .all(accountId) as { id: string; kind: string; title: string; body: string | null; link: string | null; read: number; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    read: r.read === 1,
    createdAt: r.created_at,
  }));
}

export function markNotificationsRead(accountId: string): void {
  db.prepare('UPDATE notifications SET read = 1 WHERE account_id = ?').run(accountId);
}
