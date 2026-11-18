// Player keyboard shortcuts: defaults, plus the ones a profile changed in Settings → Playback.

export const SHORTCUTS = [
  { id: 'playPause', label: 'Play / pause', keys: [' ', 'k'] },
  { id: 'back5', label: 'Back 5 seconds', keys: ['arrowleft'] },
  { id: 'forward5', label: 'Forward 5 seconds', keys: ['arrowright'] },
  { id: 'back10', label: 'Back 10 seconds', keys: ['j'] },
  { id: 'forward10', label: 'Forward 10 seconds', keys: ['l'] },
  { id: 'volumeUp', label: 'Volume up', keys: ['arrowup'] },
  { id: 'volumeDown', label: 'Volume down', keys: ['arrowdown'] },
  { id: 'mute', label: 'Mute', keys: ['m'] },
  { id: 'fullscreen', label: 'Full screen', keys: ['f'] },
  { id: 'subtitles', label: 'Subtitles on / off', keys: ['c'] },
  { id: 'skip', label: 'Skip intro / credits', keys: ['s'] },
  { id: 'next', label: 'Next episode', keys: ['n'] },
  { id: 'faster', label: 'Faster', keys: ['>'] },
  { id: 'slower', label: 'Slower', keys: ['<'] },
  { id: 'pip', label: 'Picture-in-picture', keys: ['p'] },
  { id: 'screenshot', label: 'Screenshot', keys: ['x'] },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

/** key -> action. A changed shortcut replaces all of that action's default keys. */
export function shortcutMap(overrides: Record<string, string> | undefined): Map<string, ShortcutId> {
  const map = new Map<string, ShortcutId>();
  for (const s of SHORTCUTS) {
    const custom = overrides?.[s.id];
    for (const k of custom ? [custom] : s.keys) if (!map.has(k)) map.set(k, s.id);
  }
  return map;
}

export function keyLabel(k: string): string {
  if (k === ' ') return 'Space';
  if (k.startsWith('arrow')) return { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' }[k] ?? k;
  return k.length === 1 ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1);
}

/** The key a keydown means, in the same form as the table above. */
export const eventKey = (e: KeyboardEvent) => e.key.toLowerCase();
