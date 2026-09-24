import type { ContainerFamily } from './types';

/**
 * Container families as PURE functions of a permlink (quote reblog spec v2, section 2).
 * No imports beyond a type, so client components (the post page) and server code (the
 * publisher, the comment redirect, the container repository) share one definition.
 *
 * `lumen-c-<ulid>` roots collect Lumen POSTS; `lumen-q-<ulid>` roots collect reblog
 * comments. Code that asks "is this a Lumen post?" must use `containerFamilyOf(...) ===
 * 'lite'`, never `isContainerPermlink`, which is true for both.
 */
export const CONTAINER_PREFIX: Record<ContainerFamily, string> = { lite: 'lumen-c-', quote: 'lumen-q-' };

/** Which family a container permlink belongs to, or null when it is not a container. */
export function containerFamilyOf(permlink: string | null | undefined): ContainerFamily | null {
  if (!permlink) return null;
  if (permlink.startsWith(CONTAINER_PREFIX.lite)) return 'lite';
  if (permlink.startsWith(CONTAINER_PREFIX.quote)) return 'quote';
  return null;
}

/** A container root of either family (the publisher opens both; neither is a page to land on). */
export function isContainerPermlink(permlink: string | null | undefined): boolean {
  return containerFamilyOf(permlink) !== null;
}
