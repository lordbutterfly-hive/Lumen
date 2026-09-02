import { notFound } from 'next/navigation';

/**
 * ★ WHERE AN INVALID TOPIC URL LANDS (snappiness phase 4, 2026-09-03).
 *
 * `/topics/[tag]` gained a loading boundary so a click commits at once. The
 * price: anything the page throws AFTER the boundary has streamed, including
 * `notFound()`, arrives with the 200 the shell already sent (found in review:
 * `/topics/has%20space` answered 200 with the not-found copy). So the
 * middleware validates the tag first and rewrites an invalid one here, a
 * static sibling segment with no loading boundary, where `notFound()` still
 * produces a real 404. The folder name contains a dot, which no valid tag can.
 */
export default function InvalidTopicPage(): never {
  notFound();
}
