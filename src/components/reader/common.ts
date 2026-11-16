import type { Preferences } from '../../lib/types';
import type { Annotation } from '../../lib/types';

export interface ReaderHandle {
  next: () => void;
  prev: () => void;
  goTo: (locator: string) => void;
  goToPercent: (p: number) => void;
  removeHighlight?: (locator: string) => void;
}

export interface ReaderViewProps {
  prefs: Preferences['reader'];
  initialLocator: string | null;
  annotations: Annotation[];
  onLocation: (locator: string, percent: number, label?: string) => void;
  onSelect?: (s: { locator: string; text: string; x: number; y: number }) => void;
  onToc?: (toc: { label: string; href: string }[]) => void;
  onTap: () => void;
}

export function themeColors(p: Preferences['reader']): { bg: string; fg: string; dark: boolean } {
  switch (p.theme) {
    case 'sepia':
      return { bg: '#f4ecd8', fg: '#5b4636', dark: false };
    case 'paper':
      return { bg: '#fbfbf8', fg: '#1d1d1f', dark: false };
    case 'custom':
      return { bg: p.customBg, fg: p.customFg, dark: isDark(p.customBg) };
    default:
      return { bg: '#101014', fg: '#e8e6e3', dark: true };
  }
}

function isDark(hex: string): boolean {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0'), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}
