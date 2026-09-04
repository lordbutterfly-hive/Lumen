import { KeyType } from '@smart-signer/types/common';
import { create } from 'zustand';
import { mountStoreDevtool } from 'simple-zustand-devtools';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';

// The retention slice that used to live here (reduce-motion pref, banked streak
// freezes, today's forgeable task claims) was removed with the XP/daily-task
// layer on 2026-08-08. Every field was write-only: its sole reader was the
// daily-tasks popover, which was never mounted, and `hydrateRetention` had no
// caller at all. Rank is chain/Lumen-derived and never client-supplied — see
// features/retention/lib/compute-league.ts.

interface AppState {
  currentProfile: FullAccount | null;
  setCurrentProfile: (currentProfile: FullAccount | null) => void;
  currentProfileKeyType: KeyType | null;
  setCurrentProfileKeyType: (currentProfileKeyType: KeyType | null) => void;
  lastReadNotificationDate: number;
  setLastReadNotificationDate: (lastReadNotificationDate: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentProfile: null,
  setCurrentProfile: (currentProfile) => set(() => ({ currentProfile })),
  currentProfileKeyType: null,
  setCurrentProfileKeyType: (currentProfileKeyType) => set(() => ({ currentProfileKeyType })),
  lastReadNotificationDate: 0,
  setLastReadNotificationDate: (lastReadNotificationDate) => set(() => ({ lastReadNotificationDate }))
}));

if (process.env.NODE_ENV === 'development') {
  mountStoreDevtool('AppStore', useAppStore);
}
