// The desktop app (Electron) adds `window.novaDesktop` to Nova's pages; in a browser it's simply absent.
import { useEffect, useState } from 'react';

export interface DesktopUpdate {
  supported: boolean;
  status: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  version?: string;
  progress?: number;
  error?: string;
  checkedAt?: number;
}

export interface DesktopSettings {
  autoUpdate: boolean;
  discord: boolean;
  /** null: Nova's usual port (11471). */
  port: number | null;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  settings: DesktopSettings;
  /** The port the server is on right now. */
  port: number;
  update: DesktopUpdate;
  discordAvailable: boolean;
}

export interface Activity {
  kind: 'watching' | 'reading' | 'listening';
  title: string;
  subtitle?: string | null;
  image?: string | null;
  /** Unix seconds. */
  start?: number;
  end?: number;
  paused?: boolean;
}

interface DesktopApi {
  platform: string;
  info(): Promise<DesktopInfo | null>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  relaunch?(): Promise<boolean>;
  checkForUpdates(): Promise<DesktopUpdate | null>;
  installUpdate(): Promise<boolean>;
  onUpdate(cb: (s: DesktopUpdate) => void): () => void;
  setActivity(a: Activity | null): void;
}

declare global {
  interface Window {
    novaDesktop?: DesktopApi;
  }
}

export const desktop: DesktopApi | undefined = typeof window !== 'undefined' ? window.novaDesktop : undefined;

export const PLATFORM_NAME: Record<string, string> = { win32: 'Windows app', darwin: 'Mac app', linux: 'Linux app' };

export function useDesktopInfo() {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void desktop.info().then((i) => live && setInfo(i));
    const off = desktop.onUpdate((update) => setInfo((i) => (i ? { ...i, update } : i)));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [info, setInfo] as const;
}

/** "Watching X" in Discord (desktop app, only when turned on in Settings → About). */
export function setPresence(a: Activity | null) {
  desktop?.setActivity(a);
}

/** Artwork Discord can show: it fetches images itself, so only public https URLs work. */
export function publicImage(url: string | null | undefined): string | null {
  return url && /^https:\/\//.test(url) ? url : null;
}
