/**
 * `Promise.allSettled` with at most `limit` calls in flight. Pure, unit tested.
 *
 * ★ WHY NOT `allSettled` OVER EVERYTHING (review 2026-09-05). The People tab
 * hydrates up to twelve names through `bridge.get_profile`; twelve calls at
 * once per anonymous request is a fan-out a Hive node answers with 429 under
 * load (the profile layout's own history, `cached-api.ts`). Four at a time
 * costs ~3 rounds x ~200ms instead of one round, which nobody notices behind
 * a 60s memo, and it bounds what one request can make us do upstream.
 * Order of results matches the order of `items`, like `allSettled`.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
