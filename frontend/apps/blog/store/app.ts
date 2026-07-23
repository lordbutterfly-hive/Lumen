import { KeyType } from '@smart-signer/types/common';
import { create } from 'zustand';
import { mountStoreDevtool } from 'simple-zustand-devtools';
import { FullAccount } from '@hive/common-hiveio-packages/wax';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import type { DailyTaskId } from '@/blog/features/retention/types';

// ---------------------------------------------------------------------------
// Retention (cosmetic / HABIT-layer) slice. Holds ONLY cosmetic prefs, banked
// streak freezes, and today's forgeable task claims — never the money contract
// and never a league input. Persisted through storage-with-ttl (never raw
// localStorage); the forgeable-claims map is UTC-date-keyed with a SESSION TTL.
// ---------------------------------------------------------------------------
const REDUCE_MOTION_KEY = 'retention:reduceMotion';
const FREEZE_COUNT_KEY = 'retention:freezeCount';
const utcDate = (): string => new Date().toISOString().slice(0, 10);
const claimsKey = (): string => `retention:claims:${utcDate()}`;

type ForgeableClaims = Partial<Record<DailyTaskId, boolean>>;

interface AppState {
  currentProfile: FullAccount | null;
  setCurrentProfile: (currentProfile: FullAccount | null) => void;
  currentProfileKeyType: KeyType | null;
  setCurrentProfileKeyType: (currentProfileKeyType: KeyType | null) => void;
  lastReadNotificationDate: number;
  setLastReadNotificationDate: (lastReadNotificationDate: number) => void;

  // Retention cosmetic slice
  retentionReduceMotion: boolean;
  retentionFreezeCount: number;
  retentionClaims: ForgeableClaims;
  setRetentionReduceMotion: (reduceMotion: boolean) => void;
  setRetentionFreezeCount: (freezeCount: number) => void;
  claimForgeableTask: (id: DailyTaskId) => void;
  hydrateRetention: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  currentProfile: null,
  setCurrentProfile: (currentProfile) => set(() => ({ currentProfile })),
  currentProfileKeyType: null,
  setCurrentProfileKeyType: (currentProfileKeyType) => set(() => ({ currentProfileKeyType })),
  lastReadNotificationDate: 0,
  setLastReadNotificationDate: (lastReadNotificationDate) => set(() => ({ lastReadNotificationDate })),

  retentionReduceMotion: false,
  retentionFreezeCount: 0,
  retentionClaims: {},
  setRetentionReduceMotion: (retentionReduceMotion) => {
    setStorageItem(REDUCE_MOTION_KEY, retentionReduceMotion, StorageTTL.PERMANENT);
    set(() => ({ retentionReduceMotion }));
  },
  setRetentionFreezeCount: (retentionFreezeCount) => {
    setStorageItem(FREEZE_COUNT_KEY, retentionFreezeCount, StorageTTL.PERMANENT);
    set(() => ({ retentionFreezeCount }));
  },
  claimForgeableTask: (id) => {
    const next: ForgeableClaims = { ...get().retentionClaims, [id]: true };
    setStorageItem(claimsKey(), next, StorageTTL.SESSION);
    set(() => ({ retentionClaims: next }));
  },
  hydrateRetention: () => {
    const reduceMotion = getStorageItem<boolean>(REDUCE_MOTION_KEY);
    const freezeCount = getStorageItem<number>(FREEZE_COUNT_KEY);
    const claims = getStorageItem<ForgeableClaims>(claimsKey());
    set(() => ({
      retentionReduceMotion: reduceMotion ?? false,
      retentionFreezeCount: freezeCount ?? 0,
      retentionClaims: claims ?? {}
    }));
  }
}));

if (process.env.NODE_ENV === 'development') {
  mountStoreDevtool('AppStore', useAppStore);
}
