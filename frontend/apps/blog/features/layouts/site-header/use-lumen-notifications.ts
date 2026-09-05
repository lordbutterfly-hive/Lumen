'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';

/**
 * ★★★ THE BELL SAID 1 AND OPENED TO 4 (2026-08-16, owner, reported live).
 *
 * The badge was drawn from `bridge.unread_notifications`, which is the CHAIN and
 * only the chain. The panel below it rendered chain rows PLUS Lumen-native rows
 * (new followers, `/api/lite/notifications`), fetched separately and only once
 * the popover was already open. So the two halves of one control counted
 * different things: the badge could say 1 while the list showed 4, and for a
 * lite reader — who has no chain account at all — the badge was permanently 0
 * no matter how many people followed them.
 *
 * This hook is the single Lumen-side source both halves now read. The header
 * owns the fetch (so the badge can count before anything is opened) and hands
 * the rows to the panel, which is why there is exactly ONE request rather than
 * one per surface.
 *
 * UNREAD, FOR EVENTS THAT ARE NOT ON CHAIN. The chain half has a real cutoff:
 * `bridge` returns `lastread`, written by the `setLastRead` custom_json. Lumen
 * follows are not chain events and have no such record, so the cutoff is kept
 * locally, per account, and advanced when the reader actually opens the bell.
 * That is honest about what it is — a per-device "you have seen these" mark, not
 * a claim about a global read state — and it is the same thing the chain's own
 * cutoff means to a single reader. `PERMANENT` because a read mark that expires
 * would resurrect months-old follows as "new".
 *
 * Deliberately NOT written on hover or on render: the mark has to cost a
 * deliberate act, or the badge clears itself for a reader who never looked.
 */
export interface LumenNotification {
  type: 'follow' | 'dm';
  msg: string;
  url: string;
  date: string;
  /**
   * The account that caused the event, without the leading `@`. Sent explicitly
   * by the route rather than parsed back out of `msg`/`url` at the call site: an
   * avatar keyed off a sliced display string breaks the first time the sentence
   * is reworded or translated.
   */
  actor?: string;
  source?: 'lumen';
}

const seenKey = (username: string) => `lumen-notifications-seen:${username}`;

export function useLumenNotifications(username: string) {
  const { data } = useQuery({
    queryKey: ['LumenNotifications', username],
    queryFn: async (): Promise<LumenNotification[]> => {
      const res = await fetch(`/api/lite/notifications?hive=${encodeURIComponent(username)}`);
      if (!res.ok) return [];
      const body = (await res.json()) as { notifications?: LumenNotification[] };
      return body.notifications ?? [];
    },
    enabled: !!username,
    // This now runs on every page load rather than only when the bell is
    // opened, which is the whole point — but the header remounts on each
    // navigation, and a follower list does not change fast enough to justify a
    // request per route change. Worst case the badge is a minute behind.
    staleTime: 60_000
  });

  // Read AFTER mount, never during render: localStorage does not exist on the
  // server, and seeding state from it directly makes the first client render
  // disagree with the server's HTML.
  const [seenAt, setSeenAt] = useState<number>(0);
  useEffect(() => {
    if (!username) return;
    setSeenAt(getStorageItem<number>(seenKey(username)) ?? 0);
  }, [username]);

  const items = data ?? [];
  const unread = items.filter((n) => {
    const at = new Date(n.date).getTime();
    return Number.isFinite(at) && at > seenAt;
  }).length;

  const markSeen = useCallback(() => {
    if (!username) return;
    const now = Date.now();
    setStorageItem(seenKey(username), now, StorageTTL.PERMANENT);
    setSeenAt(now);
  }, [username]);

  return { items, unread, markSeen };
}
