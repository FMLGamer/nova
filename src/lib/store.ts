import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { setApiProfile } from './api';
import type { AssistantContext } from './types';

interface AppState {
  profileId: string | null;
  setProfile: (id: string | null) => void;

  /** Blurred backdrop glowing behind the page — set by heroes and title pages. */
  ambient: string | null;
  setAmbient: (url: string | null) => void;

  palette: boolean;
  setPalette: (open: boolean) => void;

  assistant: { open: boolean; context: AssistantContext | null };
  openAssistant: (context?: AssistantContext | null) => void;
  closeAssistant: () => void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      profileId: null,
      setProfile: (id) => {
        setApiProfile(id);
        set({ profileId: id });
      },
      ambient: null,
      setAmbient: (url) => set({ ambient: url }),
      palette: false,
      setPalette: (open) => set({ palette: open }),
      assistant: { open: false, context: null },
      openAssistant: (context = null) => set({ assistant: { open: true, context } }),
      closeAssistant: () => set((s) => ({ assistant: { ...s.assistant, open: false } })),
    }),
    {
      name: 'nova.app',
      partialize: (s) => ({ profileId: s.profileId }),
      onRehydrateStorage: () => (state) => setApiProfile(state?.profileId ?? null),
    },
  ),
);

// Make the header available before React renders (persist hydrates synchronously from localStorage).
setApiProfile(useApp.getState().profileId);

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'ok' | 'bad';
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dismiss: (id: number) => void;
}

let toastSeq = 0;
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (text, tone = 'info', action) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, action }] }));
    window.setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 7000 : 4200);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (text: string, tone?: Toast['tone'], action?: Toast['action']) => useToasts.getState().push(text, tone, action);

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
