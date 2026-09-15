/**
 * The reader's choice to hide the Hive builders card (owner, 2026-09-15: "add
 * a button to hide this on top right. if someone hides it that persists in
 * their cache so its hidden until they open it").
 *
 * Stored in localStorage in the SAME envelope `@ui/lib/storage-with-ttl`
 * writes (`{ value, expiresAt, createdAt }`, `expiresAt: null` = permanent),
 * so `StorageCleanup` recognises it and never sweeps it. Not written through
 * that helper directly: this module takes the storage as an argument so the
 * unit test can hand it a fake, a throwing one, or none — the browser cases
 * (private windows, blocked site data, full quota) all show up as one of
 * those, and every one of them must degrade to "shown", never to a throw.
 *
 * Only the hidden state is recorded; "shown" is the default and removes the
 * key, so a reader who never touched the button leaves nothing behind.
 */
export const BUILDERS_HIDDEN_KEY = 'lumen.rail.builders.hidden.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` if this runtime has one and lets us touch it; null otherwise. Never throws. */
export function browserStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readBuildersHidden(storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(BUILDERS_HIDDEN_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && (parsed as { value?: unknown }).value === true;
  } catch {
    return false;
  }
}

export function writeBuildersHidden(hidden: boolean, storage: StorageLike | null = browserStorage(), now: number = Date.now()): void {
  if (!storage) return;
  try {
    if (hidden) storage.setItem(BUILDERS_HIDDEN_KEY, JSON.stringify({ value: true, expiresAt: null, createdAt: now }));
    else storage.removeItem(BUILDERS_HIDDEN_KEY);
  } catch {
    // Quota or a blocked store: the choice holds for this page view and is
    // asked again next time. Nothing to tell the reader.
  }
}
