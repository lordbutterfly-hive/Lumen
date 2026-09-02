import type { Entry } from '@hive/common-hiveio-packages/wax';

export interface TopicResponse {
  entries: Entry[];
  source: string;
  degraded?: string;
  nextCursor?: { author: string; permlink: string } | null;
}

export const TOPIC_PAGE_LIMIT = 30;

/** React Query key for a topic's infinite feed; the tag is always lower-case. */
export const topicFeedKey = (tag: string) => ['topicFeed', tag.toLowerCase()] as const;

/**
 * One page of `/api/feed/for-you?tag=`. Shared by TopicShell (the page) and
 * the hover-intent prefetch on topic links (snappiness phase 4), so a prefetched
 * page and a fetched page are byte-for-byte the same request and land under the
 * same key.
 */
export async function fetchTopicPage(
  tag: string,
  cursor?: { author?: string; permlink?: string } | undefined
): Promise<TopicResponse> {
  const params = new URLSearchParams({ tag: tag.toLowerCase(), limit: String(TOPIC_PAGE_LIMIT) });
  if (cursor?.author && cursor?.permlink) {
    params.set('startAuthor', cursor.author);
    params.set('startPermlink', cursor.permlink);
  }
  const res = await fetch(`/api/feed/for-you?${params.toString()}`);
  if (!res.ok) throw new Error(`topic ${res.status}`);
  return (await res.json()) as TopicResponse;
}
