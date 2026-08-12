'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { liteBlock } from '@/blog/lib/lite/client/lite-write';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';
import { Skeleton, UserAvatarImg } from '@ui/components';
import BasePathLink from '@/blog/components/base-path-link';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from './lib/card';

interface BlockedPeer {
  name: string;
  kind: 'hive' | 'lumen';
}

/**
 * ★★★ "MAKE SURE IT PERSISTS" (owner ruling, 2026-08-12) — THIS CARD IS THE PROOF.
 *
 * A Lumen Block writes a real, durable row (`lumen_block`, soft-deleted on unblock —
 * see `block-repository.ts`) and it already survives a reload: the bug the owner was
 * almost certainly reacting to is not that blocks were lost, it is that there was NO
 * PLACE THAT SHOWED THEM. Mute and Blacklist have lived at `/@you/lists/muted` and
 * `/@you/lists/blacklisted` since before this feature existed; Block had no `/lists`
 * page of its own and no settings card, so a viewer who blocked someone had no way to
 * come back later and confirm it, and — the part that actually matters — no way to
 * ever undo it. `block-repository.ts`'s `listBlockedPeers` doc already anticipated
 * this screen ("The people behind the list — for a 'Blocked accounts' settings
 * screen"); nothing rendered it until now.
 *
 * Modelled on `muted-list.tsx` (same card chrome, same avatar/name/action row, same
 * owner-gate shape), reusing `/api/lite/block/list` — the same endpoint the reader-
 * side feed/thread filters already call — via its `peers` field, which carries the
 * per-account (name, name-space) pairing a settings row needs and the merged
 * `keys`/`userIds`/`names` fields (built for filter-matching) do not.
 *
 * ★ TIER-AGNOSTIC, UNLIKE `MutedList`. Block works for every combination of the two
 * account tiers (see `block-service.ts`), so this card asks only "is this your own
 * settings page", never "do you have a Hive account" — a lite account can have
 * blocked people too, and needs to be able to see and undo it exactly like a full one.
 */
const BlockedList = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');
  const identity = useSessionIdentity();
  const isOwner = identity.isLoggedIn && identity.username === username;
  const queryClient = useQueryClient();
  const [pendingName, setPendingName] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['lumenBlockedPeers'],
    enabled: isOwner,
    queryFn: async (): Promise<BlockedPeer[]> => {
      // ★ AN EMPTY BLOCK LIST AND A FAILED READ MUST NOT LOOK THE SAME (2026-08-12).
      //
      // This returned `[]` on any failure, which this card renders as its
      // "you have not blocked anyone" empty state. So a database hiccup told the
      // reader their blocks were GONE — on the one screen whose entire job is to say
      // who they have blocked. The plausible reaction to that is to go and block
      // everybody again, and the second-most plausible is to assume the feature is
      // broken. Same shape as the mute read that reported a timeout as "you mute
      // nobody"; same fix — let it throw so React Query retries and sets `isError`,
      // and render that as its own state rather than as emptiness.
      //
      // `res.ok` is the HTTP status; the route answers 200 even when it degrades, and
      // reports the real outcome in the body's `ok`. Both are checked.
      const res = await fetch('/api/lite/block/list');
      if (!res.ok) throw new Error(`block list read failed: HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; peers?: BlockedPeer[] };
      if (body.ok === false) throw new Error('block list read failed server-side');
      return body.peers ?? [];
    }
  });

  // Nobody else's block list is any of the current viewer's business, and this card
  // has nothing true to say about it either way — same "say nothing" rule
  // `MutedList` follows for the same reason.
  if (!isOwner) return null;

  const handleUnblock = async (peer: BlockedPeer) => {
    setPendingName(peer.name);
    const result = await liteBlock(peer.name, peer.kind, true);
    setPendingName(null);
    if (result.status === 'error') {
      handleError(new Error(result.message), { method: 'lumen-unblock', params: { username: peer.name } });
      return;
    }
    // Re-read rather than removing the row locally — same reasoning
    // `use-lumen-block.ts` documents: only the server knows whether the edge
    // actually changed, and the reader-side feed/thread filters need to know too.
    await queryClient.invalidateQueries({ queryKey: ['lumenBlockedPeers'] });
    await queryClient.invalidateQueries({ queryKey: ['lumenBlockList'] });
    await queryClient.invalidateQueries({ queryKey: ['forYouRanked'] });
  };

  return (
    <section className={SETTINGS_CARD} data-testid="settings-blocked-accounts">
      <h2 className={SETTINGS_CARD_TITLE}>{t('settings_page.blocked_accounts')}</h2>
      <p className={SETTINGS_CARD_HINT}>{t('settings_page.blocked_accounts_hint')}</p>

      {isLoading ? (
        <div className="mt-4 space-y-2" data-testid="settings-blocked-accounts-skeleton">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        // ★ Checked BEFORE the empty state, and that ordering is the fix. `data` is
        // `undefined` on a failed read, so the empty branch below would otherwise
        // catch it and state, in plain language, that this reader has blocked nobody.
        <p
          className="mt-4 rounded-[14px] border border-[#eee2dc] bg-[#fbfbfa] px-4 py-5 text-center text-[13.5px] text-[#6b7280]"
          data-testid="settings-blocked-accounts-error"
        >
          {t('settings_page.blocked_accounts_error')}
        </p>
      ) : !data || data.length === 0 ? (
        <p className="mt-4 rounded-[14px] bg-[#f7f7f7] px-4 py-5 text-center text-[13.5px] text-[#6b7280]">
          {t('settings_page.blocked_accounts_empty')}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[#f1f3f5] border-t border-[#f1f3f5]">
          {data.map((peer) => {
            const pending = pendingName === peer.name;
            return (
              <li key={`${peer.kind}:${peer.name}`} className="flex items-center gap-3 px-1 py-3">
                <UserAvatarImg username={peer.name} pixelSize={36} />

                <BasePathLink
                  href={`/@${peer.name}`}
                  className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[#161511] hover:text-[#c0392b]"
                >
                  @{peer.name}
                </BasePathLink>

                <button
                  type="button"
                  data-testid="settings-unblock-button"
                  className="inline-flex h-9 min-w-[92px] items-center justify-center rounded-[14px] border border-[#e4e6e9] bg-white px-4 text-[13px] font-bold text-[#c0392b] transition-colors hover:border-[#c0392b] hover:bg-[#fdf2f0] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => handleUnblock(peer)}
                  disabled={pending}
                >
                  {pending ? (
                    <CircleSpinner loading size={16} color="#c0392b" />
                  ) : (
                    t('settings_page.unblock_button')
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default BlockedList;
