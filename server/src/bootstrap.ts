import crypto from 'node:crypto';
import os from 'node:os';
import { config } from './config.js';
import { hashPassword } from './auth/password.js';
import { countAccounts, createAccount } from './services/accounts.js';
import { createProfile } from './services/profiles.js';

/**
 * Creates the first admin account on an empty database. Account creation is
 * otherwise invite-gated, so this is the only way to seed the initial admin who
 * can then mint invite codes. Password comes from ADMIN_PASSWORD, or a random
 * one is generated and printed once.
 */
export function bootstrapAdmin(): void {
  if (countAccounts() > 0) return;

  const username = config.admin.username;
  let password = config.admin.password;
  let generated = false;
  if (!password) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }

  const account = createAccount({ username, passwordHash: hashPassword(password), isAdmin: true });
  // The desktop app signs its owner in itself; name the profile after the computer's user (Android has none worth using).
  const userName = () => {
    try {
      return process.platform === 'android' ? '' : os.userInfo().username;
    } catch {
      return '';
    }
  };
  const profileName = config.mode === 'desktop' ? (userName() || 'Me').slice(0, 30) : username;
  createProfile(account.id, { name: profileName });

  console.log(`[bootstrap] created admin account '${username}'`);
  if (generated && config.mode !== 'desktop') {
    console.log(
      `[bootstrap] generated admin password: ${password}  (set ADMIN_PASSWORD to choose your own)`,
    );
  }
}
