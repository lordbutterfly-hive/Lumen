import type { Entry } from '@hive/common-hiveio-packages/wax';
import { trimFeedBody, trimJsonMetadata } from '@/blog/lib/feed/topic-cache';

/**
 * ★★★ WHAT A POST-CARD SEED ACTUALLY NEEDS, AND NOTHING MORE (2026-09-03,
 * snappiness phase 3). A card shows a title, a plaintext dek (getPostSummary:
 * json_metadata.description, else the first chars of the body) and a vote/
 * payout row; it reads `active_votes` ONLY to know whether the current viewer
 * already voted (medium-post-card.tsx checkVote). Yet an SSR seed of a feed or
 * a profile carried every post's FULL body and FULL vote list.
 *
 * Measured on a real profile (/@bozz, 20 posts) before this ran: the React
 * Query seed embedded in the page HTML was 870 KB, of which active_votes was
 * 668 KB (77%) and bodies 156 KB (18%). Keeping the viewer's own vote plus the (rare) downvotes and
 * capping the body leaves ~130 KB, an ~85% cut, on every profile and every
 * signed-out reader (who has no votes at all). The home and topic feeds
 * already did this (route trimFeedEntries / anonymousTopicSeed); the profile
 * posts seed was the one path that did not.
 *

 * `viewer` is the signed-in username or '' for anonymous. Downvotes are kept for
 * everyone so the down chip stays exact; anonymous keeps no UPvote detail. The page for a signed-out reader is also the one a shared cache holds,
 * so this is what makes the cached profile small as well.
 */
export function trimEntriesForSeed(entries: Entry[], viewer: string): Entry[] {
  const me = (viewer || '').toLowerCase();
  return entries.map((entry) => {
    const votes = Array.isArray(entry.active_votes) ? entry.active_votes : [];
    return {
      ...entry,
      json_metadata: trimJsonMetadata(entry.json_metadata) as Entry['json_metadata'],
      // Keep the viewer's own vote (the "did I vote" SSR check) AND every
      // DOWNVOTE. splitTally (features/votes/vote-tallies.ts) counts others'
      // downvotes from active_votes to show the down chip; the up total comes
      // from stats.total_votes. Downvotes are rare (measured <1% of votes), so
      // keeping them preserves the card's tally exactly while still dropping the
      // upvote bulk that made this seed 77% votes. Found in review.
      active_votes: votes.filter(
        (vote) => (me && (vote.voter ?? '').toLowerCase() === me) || Number(vote.rshares) < 0
      ),
      body: trimFeedBody(entry.body ?? '')
    };
  });
}
