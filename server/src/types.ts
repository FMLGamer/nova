export interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  is_admin: number;
  invite_id: string | null;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  account_id: string;
  name: string;
  avatar: string;
  is_kids: number;
  sort_order: number;
  created_at: string;
}

export interface InviteRow {
  id: string;
  code: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  used_by: string | null;
  used_at: string | null;
  revoked: number;
}

/** Client-facing shapes (camelCase, no secrets). */
export interface AccountDTO {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export interface ProfileDTO {
  id: string;
  name: string;
  avatar: string;
  isKids: boolean;
  sortOrder: number;
}

export interface InviteDTO {
  id: string;
  code: string;
  note: string | null;
  createdAt: string;
  usedByUsername: string | null;
  usedAt: string | null;
  revoked: boolean;
  status: 'available' | 'used' | 'revoked';
}
