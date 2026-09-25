'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { lumenNotificationsQuery } from '@/blog/features/layouts/site-header/use-lumen-notifications';
import { marksAfterOpen, unreadCount, type LumenNotificationType, type SeenMarks } from '@/blog/lib/meritum/notification-rows';

/**
 * What changes in the inbox's Asks tab: a request to you (`order`), an answer to yours
 * (`delivered`, `declined`), a rating on your delivery (`rated`), and a buyer reclaiming
 * after the deadline (`missed`). Not `buy` (a token purchase, no ask) and not
 * `order_placed` (the buyer's own receipt for what they just did).
 */
export const INBOX_ASK_TYPES: ReadonlySet<LumenNotificationType> = new Set<LumenNotificationType>([
  'order',
  'delivered',
  'declined',
  'rated',
  'missed'
]);

const marksKey = (username: string) => `lumen-inbox-asks-seen:${username}`;
// The header's badge and the inbox page each hold this hook; the one that marks tells the
// others, or the envelope would keep its number until the next page load.
const SEEN_EVENT = 'lumen:inbox-asks-seen';

function readMarks(username: string): SeenMarks | null {
  const stored = getStorageItem<SeenMarks>(marksKey(username));
  return stored && Array.isArray(stored.ids)
    ? { ids: stored.ids.filter((id) => typeof id === 'string'), seenAt: Number(stored.seenAt) || 0 }
    : null;
}

/**
 * ★ THE INBOX'S RED NUMBER COUNTS ASKS TOO (2026-09-26, owner: "if you get anything in
 * inbox do you get a red notification on it? you should").
 *
 * The rows are the bell's own (`lumenNotificationsQuery`, one cached request for both),
 * filtered to the ask lifecycle. The inbox keeps its OWN seen-set, so the bell and the
 * inbox each clear when they are looked at: opening the Asks tab clears this one, opening
 * the bell clears the bell's. Like the bell's, it is per device (localStorage), and keyed
 * on each row's event id, never its date (the indexer dates a row by its block and serves
 * it minutes later; see use-lumen-notifications.ts).
 *
 * The first time a device has no set, everything already there counts as seen, so the
 * badge starts at what arrives from now on rather than lighting up with old history.
 */
export function useInboxAskNews(username: string) {
  const { data, isSuccess } = useQuery(lumenNotificationsQuery(username));
  const rows = useMemo(() => (data ?? []).filter((r) => r.id && INBOX_ASK_TYPES.has(r.type)), [data]);
  const [marks, setMarks] = useState<SeenMarks | null>(null);

  // Another account signed in on this page: its own set, read afresh below.
  useEffect(() => setMarks(null), [username]);
  useEffect(() => {
    if (!username || !isSuccess) return;
    setMarks((current) => {
      if (current) return current;
      const stored = readMarks(username);
      if (stored) return stored;
      const seeded = marksAfterOpen(rows, { ids: [], seenAt: 0 }, Date.now());
      setStorageItem(marksKey(username), seeded, StorageTTL.PERMANENT);
      return seeded;
    });
  }, [username, isSuccess, rows]);
  useEffect(() => {
    if (!username) return;
    const onSeen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === username) setMarks(readMarks(username));
    };
    window.addEventListener(SEEN_EVENT, onSeen);
    return () => window.removeEventListener(SEEN_EVENT, onSeen);
  }, [username]);

  const count = marks ? unreadCount(rows, marks) : 0;

  // Called when the Asks tab is showing: everything it shows is now seen.
  const markSeen = useCallback(() => {
    if (!username) return;
    setMarks((current) => {
      const next = marksAfterOpen(rows, current ?? { ids: [], seenAt: 0 }, Date.now());
      setStorageItem(marksKey(username), next, StorageTTL.PERMANENT);
      return next;
    });
    // After this state update, outside it: the other holders re-read what was just stored.
    queueMicrotask(() => window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: username })));
  }, [username, rows]);

  return { count, markSeen };
}
