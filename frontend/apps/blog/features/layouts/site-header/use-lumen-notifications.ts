'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import { marksAfterOpen, marksFromLegacy, unreadCount, type LumenNotificationType, type SeenMarks } from '@/blog/lib/meritum/notification-rows';

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
  /**
   * A stable id for the EVENT (`order:<creator>:<seq>`, `buy:<creator>:<tx>`),
   * built by lib/meritum/notification-rows.ts. The read mark keys on it, not on
   * the timestamp - see `marks` below. Follow and DM rows carry none yet and
   * fall back to the timestamp rule.
   */
  id?: string;
  /** `buy` = somebody bought this reader's Meritum; order/order_placed/delivered/declined/rated = the request lifecycle. */
  type: LumenNotificationType;
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

/** The old single-timestamp mark, read once to seed the id set and never written again. */
const legacySeenKey = (username: string) => `lumen-notifications-seen:${username}`;
/** The id set: every row this device has actually shown, bounded, plus the last-open time for id-less rows. */
const marksKey = (username: string) => `lumen-notifications-seen-ids:${username}`;

const NO_MARKS: SeenMarks = { ids: [], seenAt: 0 };

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

  /**
   * ★★★ UNREAD IS "NOT YET SHOWN ON THIS DEVICE", NOT "NEWER THAN THE LAST OPEN"
   * (2026-09-21, owner: the "somebody bought" row was in the list and never put
   * the red number on the bell).
   *
   * The mark used to be one timestamp, advanced when the popover opened, and a
   * row counted as unread when its date was later. But a Meritum row is dated by
   * the BLOCK the event landed in, and the indexer that serves it runs minutes
   * behind the chain. Open the bell in that gap - as anyone does right after
   * placing or receiving an order - and the mark moves past the row's date
   * before the row exists, so it arrives already "read" and the badge never
   * moves. Not a race a reader can lose by being slow; it is lost by being
   * prompt.
   *
   * So the mark is now the set of row ids this device has actually rendered
   * (bounded, oldest dropped first), and a row is unread until it has been in an
   * open panel. The timestamp survives only for rows without an id (follows,
   * DMs) and as a one-time seed so an upgrade does not resurrect months of old
   * rows as new. Pure functions, unit-tested: lib/meritum/notification-rows.ts.
   */
  const [marks, setMarks] = useState<SeenMarks>(NO_MARKS);
  // The id set is read after mount (localStorage does not exist on the server).
  // `seeded` says whether this device has an id set at all; until the first
  // rows arrive there is nothing to seed the legacy timestamp against.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!username) return;
    const stored = getStorageItem<SeenMarks>(marksKey(username));
    if (stored && Array.isArray(stored.ids)) {
      setMarks({ ids: stored.ids.filter((id) => typeof id === 'string'), seenAt: Number(stored.seenAt) || 0 });
      setSeeded(true);
    } else {
      setMarks({ ids: [], seenAt: getStorageItem<number>(legacySeenKey(username)) ?? 0 });
      setSeeded(false);
    }
  }, [username]);

  const items = useMemo(() => data ?? [], [data]);

  // One-time migration: rows the old timestamp rule had already shown are
  // seeded as seen, rows it had not stay unread. Runs once, when the first
  // rows arrive on a device that has no id set yet.
  useEffect(() => {
    if (!username || seeded || items.length === 0) return;
    const next = marksFromLegacy(items, marks.seenAt);
    setStorageItem(marksKey(username), next, StorageTTL.PERMANENT);
    setMarks(next);
    setSeeded(true);
  }, [username, seeded, items, marks.seenAt]);

  const unread = unreadCount(items, marks);

  // Deliberately NOT written on hover or on render: the mark has to cost a
  // deliberate act, or the badge clears itself for a reader who never looked.
  const markSeen = useCallback(() => {
    if (!username) return;
    setMarks((current) => {
      const next = marksAfterOpen(items, current, Date.now());
      setStorageItem(marksKey(username), next, StorageTTL.PERMANENT);
      return next;
    });
  }, [username, items]);

  return { items, unread, markSeen };
}
