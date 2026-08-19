'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { liteBlock } from '@/blog/lib/lite/client/lite-write';
import { useUnmuteMutation } from '@/blog/features/mute-follow/hooks/use-mute-mutations';
import { useTranslation } from '@/blog/i18n/client';
import { handleError } from '@ui/lib/handle-error';
import { CircleSpinner } from 'react-spinners-kit';
import { Skeleton, UserAvatarImg } from '@ui/components';
import BasePathLink from '@/blog/components/base-path-link';
import { SETTINGS_CARD, SETTINGS_CARD_HINT, SETTINGS_CARD_TITLE } from './lib/card';

interface BlockedPeer {
  name: string;
  kind: 'hive' | 'lumen';
  source: 'lumen' | 'chain' | 'both';
}

/**
 * ★★★ THE ONE MODERATION LIST (owner ruling, 2026-08-12).
 *
 * "there should be no muted list. its all block list, we merged it and it works all
 * as block... mutes and blocks are treated the same." This card used to sit above two
 * others — `ModerationLists` (links out to the four legacy `/lists/*` pages) and
 * `MutedList` (a second, separately-fetched render of the chain ignore list). Both are
 * gone; this is the only moderation card on Settings now, and the four `/lists/*`
 * routes redirect here (see their `page.tsx` files) rather than rendering their own
 * content — see `chain-mute.ts` and `/api/lite/block/list` for why a "muted" list was
 * never a second concept to begin with, just a data source this list was not yet
 * reading.
 *
 * ★ "MAKE SURE IT PERSISTS" — a Lumen Block writes a real, durable row
 * (`lumen_block`, soft-deleted on unblock — see `block-repository.ts`) and survives a
 * reload on its own; the original bug this card was built to fix was that nothing
 * SHOWED it. Reuses `/api/lite/block/list`'s `peers` field — the same endpoint the
 * reader-side feed/thread filters call — which now carries BOTH a viewer's Lumen
 * blocks and their own on-chain mutes in the one array.
 *
 * ★★★ THE HONEST WRINKLE, AND WHY THE REMOVAL PATH SPLITS HERE AND ONLY HERE.
 *
 * A Lumen block is a row this app owns; unblocking retracts it instantly. A chain
 * entry (`source: 'chain'`/`'both'`, `peer.source`) is a real Hive `ignore` written
 * from PeakD, Ecency or anywhere else — there is no local row to delete, only a
 * signed on-chain unmute, which needs a real Hive signer (Keychain/HiveAuth) in the
 * browser. This is confirmed to be the ONLY case that needs handling: the owner
 * ruled directly that "Lite accounts do not have Hive mutes. They only have Lumen
 * blocks." — so `source` is never `'chain'`/`'both'` for a lite viewer's own list, and
 * this card does not build a lite-specific signing path at all.
 *
 * ★ THE DECISION: no local override. Pressing "Unblock" on a `'chain'` row does not
 * hide the entry from THIS list while the mute survives on chain — it broadcasts the
 * unmute. Two reasons. First, `chain-mute.ts` reads the chain fresh (bounded by its
 * cache TTL): a local "ignore this one" flag would fight the next refresh, which is
 * exactly the kind of two-sources-of-truth bug this whole feature exists to remove.
 * Second, and the one that actually matters: this list's entire promise is "this is
 * who Lumen is currently protecting you and your content from" — a row that says
 * Unblocked while the person is still muted on chain (and, per effect (B), still
 * hidden from everyone under this viewer's own content) would be a list that lies
 * about the viewer's own moderation state. Same wording everywhere, one button label
 * ("Unblock") on every row — but for a `'chain'`/`'both'` row it is labelled with a
 * hint explaining what pressing it actually does, rather than silently no-op'ing
 * (`liteBlock`'s unblock call has nothing to retract for a pure chain entry) or
 * silently doing something a lite reader could never confirm.
 *
 * ★ TIER-AGNOSTIC FOR THE LUMEN HALF, UNLIKE THE OLD `MutedList`. Block works for
 * every combination of the two account tiers, so this card asks only "is this your
 * own settings page" for the Lumen rows. The chain-removal path additionally needs a
 * real Hive signer, which `useUnmuteMutation` already knows how to ask for (and how
 * to fail honestly when one is not available) — no new gate is added here.
 */
const BlockedList = ({ username }: { username: string }) => {
  const { t } = useTranslation('common_blog');
  const identity = useSessionIdentity();
  const isOwner = identity.isLoggedIn && identity.username === username;
  const { user } = useUserClient();
  /**
   * ★ M10 FIX (2026-08-16) — `blocked_accounts_hint` unconditionally said
   * "including anyone you've muted on Hive from another app", which is wrong
   * for a lite reader: this card's own doc comment above records the owner's
   * ruling that "Lite accounts do not have Hive mutes. They only have Lumen
   * blocks." — so `source` is never `'chain'`/`'both'` for a lite viewer's
   * own list (confirmed by that same ruling, not assumed here), and the
   * per-row `blocked_accounts_chain_hint` badge below is already unreachable
   * for them. Only the card-level hint needed a lite-specific line. Same
   * `isLite` predicate `SettingsForm`/`PostPublishingSection` already use.
   */
  const isLite = isOwner && user.account_tier === 'lite';
  const queryClient = useQueryClient();
  const [pendingName, setPendingName] = useState<string | null>(null);
  const unmuteMutation = useUnmuteMutation();

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
  // has nothing true to say about it either way — same "say nothing" rule the old
  // `MutedList` followed for the same reason.
  if (!isOwner) return null;

  /** `source: 'lumen'`/`'both'` — a real `lumen_block` row exists; retract it. */
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

  /** `source: 'chain'` — no local row. The only removal path is a signed on-chain
   *  unmute, which needs a real Hive signer in this browser. */
  const handleChainRemove = async (peer: BlockedPeer) => {
    setPendingName(peer.name);
    try {
      await unmuteMutation.mutateAsync({ username: peer.name });
      await queryClient.invalidateQueries({ queryKey: ['lumenBlockedPeers'] });
      await queryClient.invalidateQueries({ queryKey: ['lumenBlockList'] });
    } catch (error) {
      // `useUnmuteMutation`'s own `onError` already toasts — this is the SAME
      // "resolves false forever" trap `use-lumen-block.ts` documents for its own
      // toggle, so the failure is still reported here rather than swallowed.
      handleError(error, { method: 'chain-unmute', params: { username: peer.name } });
    } finally {
      setPendingName(null);
    }
  };

  return (
    <section id="blocked-accounts" className={SETTINGS_CARD} data-testid="settings-blocked-accounts">
      <h2 className={SETTINGS_CARD_TITLE}>{t('settings_page.blocked_accounts')}</h2>
      <p className={SETTINGS_CARD_HINT}>
        {isLite ? t('settings_page.blocked_accounts_hint_lite') : t('settings_page.blocked_accounts_hint')}
      </p>

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
          className="mt-4 rounded-card border border-line-warn-3 bg-surface-5 px-4 py-5 text-center text-[14px] leading-[22px] text-ink-10"
          data-testid="settings-blocked-accounts-error"
        >
          {t('settings_page.blocked_accounts_error')}
        </p>
      ) : !data || data.length === 0 ? (
        <p className="mt-4 rounded-card bg-surface-15 px-4 py-5 text-center text-[14px] leading-[22px] italic text-ink-10">
          {t('settings_page.blocked_accounts_empty')}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-line-2 border-t border-line-2">
          {data.map((peer) => {
            const pending = pendingName === peer.name;
            const fromChain = peer.source === 'chain' || peer.source === 'both';
            return (
              <li
                key={`${peer.kind}:${peer.name}`}
                className="flex items-center gap-3 px-1 py-3"
                data-testid="settings-blocked-row"
                data-source={peer.source}
              >
                <UserAvatarImg username={peer.name} pixelSize={36} />

                <div className="min-w-0 flex-1">
                  <BasePathLink
                    href={`/@${peer.name}`}
                    className="block truncate text-[14px] leading-[22px] font-semibold text-ink-2 hover:text-ink-brand-6"
                  >
                    @{peer.name}
                  </BasePathLink>
                  {/* ★ THE CHAIN BADGE — the entry is visibly identifiable, per the
                      brief's own requirement, rather than looking like any other row
                      until the button turns out not to work the way it does for
                      everyone else. */}
                  {fromChain ? (
                    <p
                      className="mt-0.5 truncate text-caption text-ink-14"
                      data-testid="settings-blocked-chain-badge"
                    >
                      {t('settings_page.blocked_accounts_chain_hint')}
                    </p>
                  ) : null}
                </div>

                <button
                  type="button"
                  data-testid="settings-unblock-button"
                  className="inline-flex h-9 min-w-[92px] items-center justify-center rounded-card border border-line-11 bg-surface-1 px-4 text-caption font-bold text-ink-brand-6 transition-colors hover:border-line-brand-10 hover:bg-surface-brand-5 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => (fromChain ? handleChainRemove(peer) : handleUnblock(peer))}
                  disabled={pending}
                >
                  {pending ? (
                    // ★ NOT A LITERAL: this button's own idle state already reads
                    // `text-ink-brand-6` two lines up — `rgb(var(--ink-brand-6))`
                    // keeps the spinner the same red in light mode and picks up
                    // the dark-mode lift automatically, which `#c0392b` never did.
                    <CircleSpinner loading size={16} color="rgb(var(--ink-brand-6))" />
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
