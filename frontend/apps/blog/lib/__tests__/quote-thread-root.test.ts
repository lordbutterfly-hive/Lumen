/**
 * `applyOwnerBlocksToThread` on a REBLOG COMMENT's own page (quote reblog spec v2 5):
 * the comment is the thread's root, so its author's Hive mutes hide replies under it,
 * exactly as a post author's mutes do on a post. Any other comment page is unchanged.
 * Plain assertions, no runner; the chain-mute reader and the block graph are replaced
 * in `require.cache` before block-filter loads (same technique as
 * feed-cache-memory-vs-store.test.ts), so nothing touches a node or a database.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/quote-thread-root.test.ts
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';

let checks = 0;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function injectMock(specifier: string, exportsObj: Record<string, unknown>): void {
  const resolved = require.resolve(specifier);
  (require.cache as Record<string, unknown>)[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// alice (the quoter) has muted mallory on Hive; nobody else mutes anyone.
injectMock('@/blog/lib/lite/social/chain-mute', {
  chainMutedKeysOfActor: async () => new Set<string>(),
  hiveNameOfActor: async (a: { hive?: string }) => a?.hive ?? null,
  hiveNamesByUserId: async () => new Map<string, string>(),
  ownerChainMutedNamesOrThrow: async (owner: { hive?: string } | null) => (owner?.hive === 'alice' ? new Set(['mallory']) : new Set<string>())
});
injectMock('@/blog/lib/lite/social/block-actor', {
  buildEntryActorResolver: async () => ({ keyOf: (e: Entry) => `h:${e.author}` }),
  actorForDisplayedName: async (name: string) => ({ hive: name })
});
injectMock('@/blog/lib/lite/repositories/block-repository', {
  blockedPairsAmong: async () => new Set<string>(),
  pairKey: (a: string, b: string) => `${a}>${b}`
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyOwnerBlocksToThread } = require('@/blog/lib/lite/social/block-filter') as typeof import('@/blog/lib/lite/social/block-filter');

const entry = (author: string, permlink: string, parentAuthor: string, parentPermlink: string, depth: number) =>
  ({ author, permlink, parent_author: parentAuthor, parent_permlink: parentPermlink, depth, json_metadata: {} }) as unknown as Entry;

async function main(): Promise<void> {
  // The reblog comment's page: the comment (under a quote container, not fetched) + replies.
  const quotePage = [
    entry('alice', 'lumen-rq-abc', 'lumen-qpub', 'lumen-q-01xyz', 1),
    entry('mallory', 're-1', 'alice', 'lumen-rq-abc', 2),
    entry('bob', 're-2', 'alice', 'lumen-rq-abc', 2)
  ];
  const kept = (await applyOwnerBlocksToThread(quotePage)).map((e) => e.author);
  check("on a reblog comment's page, the quoter's Hive mute hides that reply", !kept.includes('mallory'), JSON.stringify(kept));
  check('...and only that one', kept.includes('alice') && kept.includes('bob'), JSON.stringify(kept));

  // The same shape under an ordinary Lumen post container: unchanged (no root, no mute reach).
  const ordinary = [
    entry('alice', 'lumen-01abc', 'lumen-qpub', 'lumen-c-01xyz', 1),
    entry('mallory', 're-1', 'alice', 'lumen-01abc', 2)
  ];
  const kept2 = (await applyOwnerBlocksToThread(ordinary)).map((e) => e.author);
  check('any other comment page is unchanged (the reply stays)', kept2.includes('mallory'), JSON.stringify(kept2));

  // eslint-disable-next-line no-console
  console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('FAIL — the test threw:', error);
  process.exit(1);
});
