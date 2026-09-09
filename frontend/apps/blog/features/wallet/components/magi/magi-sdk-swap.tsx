'use client';

/**
 * THE MAGI SDK'S OWN SWAP, embedded under everything on the Magi tab.
 *
 * Owner, 2026-09-09: "PUT THE SDK UNDER EVERYTHING in MAGI TAB. THE SDK. NOT
 * HIS ITERATION OF IT." So this file renders `MagiQuickSwap` from
 * `@vsc.eco/crosschain-widget` 0.0.3 (crosschain-sdk @410afba,
 * packages/widget/src/QuickSwap.tsx) and writes no swap UI of its own. What the
 * host supplies is exactly what the README's "direct signer" path asks for
 * (README.md:97-118): the config, the signed-in Hive username, and an
 * `onBroadcast(ops)` that signs and broadcasts the ops the widget built,
 * simulated and rc-tightened. Altera does not embed this widget (its own swap
 * predates it); the embed shape follows how Altera mounts the sibling
 * token-widget (altera-app src/routes/(authed)/custom-tokens/+page.svelte:5,24:
 * the package stylesheet plus a client-side dynamic import).
 *
 * ★ WHAT IS WIRED, AND WHY EACH THING
 *  - `pools`: the widget's default pool provider is the indexer's Hasura table
 *    (sdk/src/poolProvider.ts:9-39), the symbol-match source the security review
 *    retired as M1 (an indexer that reported negative reserves for an empty
 *    pool). The widget accepts a `PoolProvider`, so it is fed the same
 *    chain-derived reader the wallet already uses (lib/magi-swap.ts
 *    readPoolFromChain: the router's own registry and each pool's `rtr` and
 *    reserves). M1 stays closed; the SDK's math is untouched.
 *  - `onBroadcast`: the widget hands back dhive-style tuples (a `transfer` to
 *    the gateway for the deposit leg, a `custom_json` vsc.call for the swap).
 *    They are pushed onto ONE Hive transaction and signed with the ACTIVE key on
 *    the creator-tokens Hive chain (lib/magi-l1-broadcast.ts), never the app
 *    default chain, and the promise resolves only on a TERMINAL Magi status
 *    (submit.ts waitForTerminal), so the widget's own "done" is honest.
 *  - `username`: the signed-in Hive account. The SDK swap signs with a Hive
 *    active key by design (README.md:125-128: "username: For HIVE/HBD input");
 *    a wallet (EVM/Bitcoin) login has no Hive key, so for those the widget shows
 *    its own "Connect Hive wallet" state and its BTC deposit-address route
 *    (README.md:82-96) remains usable. That is the SDK's contract, reported,
 *    not worked around.
 *  - Endpoints: the widget calls the Magi node and the mapping bot from the
 *    browser (sdk/src/rc.ts:56-61, mappingBot.ts:33). Both answer CORS `*`
 *    (verified 2026-09-09); the CSP grants are in packages/middleware/lib/csp.ts,
 *    gated on this surface being configured.
 *  - The L1 balance the widget shows comes from ITS default balance provider,
 *    `https://api.hive.blog` (sdk/src/balanceProvider.ts:8): right on mainnet,
 *    and on a testnet stack it reads mainnet (no prop to redirect it).
 */
import '@vsc.eco/crosschain-widget/styles.css';
// After the package stylesheet on purpose: same selector specificity is decided by order. See magi-sdk-theme.css.
import './magi-sdk-theme.css';
import dynamic from 'next/dynamic';
import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { getAsset } from '@transaction/lib/utils';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useTranslation } from '@/blog/i18n/client';
import { MAINNET_CONFIG, TESTNET_CONFIG, type MagiConfig } from '@vsc.eco/crosschain-core';
import type { PoolProvider } from '@vsc.eco/crosschain-sdk';
import type { MagiQuickSwapProps } from '@vsc.eco/crosschain-widget';
import { getCreatorTokensConfig } from '@/blog/features/creator-tokens/lib/creator-tokens-data-source';
import { waitForTerminal } from '@/blog/lib/lite/wallet/vsc-tx/submit';
import { getMagiSwapConfig } from '../../lib/magi-swap-config';
import { readPoolFromChain } from '../../lib/magi-swap';
import { broadcastMagiL1, isMagiL1Configured } from '../../lib/magi-l1-broadcast';
import { magiAssetsKey, magiBtcKey } from '../../hooks/use-magi-assets';

// The widget itself is imported STATICALLY in ./magi-sdk-widget-client.tsx; see
// that file for why a direct dynamic import of the package breaks the build.
const MagiQuickSwap = dynamic<MagiQuickSwapProps>(() => import('./magi-sdk-widget-client'), {
  ssr: false,
  loading: () => <p className="py-6 text-center font-ui text-caption text-ink-14">…</p>
});

const CARD_CLASS = 'mb-3 rounded-panel border border-line-9 bg-surface-1 p-5';

/** The L1 symbol on the widget's transfer tuple (HIVE/HBD, or TESTS/TBD on the testnet) to the wallet's token name. */
function tokenOf(symbol: string): 'HIVE' | 'HBD' {
  const s = symbol.toUpperCase();
  if (s === 'HIVE' || s === 'TESTS') return 'HIVE';
  if (s === 'HBD' || s === 'TBD') return 'HBD';
  throw new Error(`Magi SDK swap: unexpected asset symbol ${symbol}`);
}

/** After a swap settles (the SDK's QuickSwap pays out back on L1 asynchronously), re-read on a schedule. */
const RECHECK_DELAYS_MS = [8_000, 25_000, 60_000, 120_000];

export default function MagiSdkSwap() {
  const { t } = useTranslation('common_blog');
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  const swap = getMagiSwapConfig();
  const ct = getCreatorTokensConfig();

  // The SDK signs with a Hive ACTIVE key; only a full Hive login with the Magi L1 chain configured can supply one.
  const username = user?.isLoggedIn && user.account_tier !== 'lite' && isMagiL1Configured() ? user.username : undefined;

  const config = useMemo<MagiConfig | null>(() => {
    if (!swap || !ct) return null;
    const base = swap.network === 'vsc-testnet' ? TESTNET_CONFIG : MAINNET_CONFIG;
    // The SDK appends /api/v1/graphql itself (sdk/src/rc.ts:61); hand it the base the proxy already reads.
    const gqlBase = ct.gqlUrl.replace(/\/api\/v1\/graphql\/?$/, '').replace(/\/+$/, '');
    return {
      ...base,
      dexRouterContractId: swap.dexRouterContractId,
      btcMappingContractId: swap.btcMappingContractId,
      gatewayAccount: swap.gatewayAccount,
      hiveAssetName: swap.hiveAssetName,
      hbdAssetName: swap.hbdAssetName,
      gqlUrl: gqlBase,
      gqlUrls: [gqlBase],
      indexerUrl: ct.indexerUrl ?? base.indexerUrl,
      referral: null
    };
  }, [swap, ct]);

  // M1: pools from the router's own chain state, not the indexer's symbol match.
  const pools = useMemo<PoolProvider | null>(
    () => (swap ? { getPoolDepths: (a, b) => readPoolFromChain(swap.dexRouterContractId, a, b) } : null),
    [swap]
  );

  const onBroadcast = useCallback(
    async (ops: unknown[]): Promise<{ txId: string }> => {
      if (!username) throw new Error('Connect a Hive account to sign a swap.');
      // Resolve every tuple BEFORE the builder runs (getAsset is async; the builder is sync).
      const waxOps = await Promise.all(
        ops.map(async (op) => {
          if (!Array.isArray(op) || typeof op[0] !== 'string') throw new Error('Magi SDK swap: unrecognised op shape');
          const [type, body] = op as [string, Record<string, unknown>];
          if (type === 'transfer') {
            const [value, symbol] = String(body.amount).split(' ');
            return {
              transfer_operation: {
                from: String(body.from),
                to: String(body.to),
                amount: await getAsset(value, tokenOf(symbol)),
                memo: String(body.memo ?? '')
              }
            };
          }
          if (type === 'custom_json') {
            return {
              custom_json_operation: {
                id: String(body.id),
                json: String(body.json),
                required_auths: (body.required_auths as string[]) ?? [],
                required_posting_auths: (body.required_posting_auths as string[]) ?? []
              }
            };
          }
          // Never sign a shape this host has not read.
          throw new Error(`Magi SDK swap: refusing to sign an op of type ${type}`);
        })
      );
      const { transactionId } = await broadcastMagiL1(username, (tx) => {
        for (const op of waxOps) tx.pushOperation(op as never);
      });
      const status = await waitForTerminal(transactionId, 180_000);
      if (status === 'failed') throw new Error(`Magi rejected the swap at execution (${transactionId}). Nothing moved.`);
      if (status === 'unconfirmed') {
        toast({ title: t('wallet.magi.send.unconfirmed_title'), description: t('wallet.magi.send.unconfirmed_body', { id: transactionId }) });
      }
      return { txId: transactionId };
    },
    [username, t]
  );

  const onSuccess = useCallback(
    (txId: string) => {
      toast({ title: t('wallet.magi.sdk.success_title'), description: t('wallet.magi.sdk.success_body', { txId }), variant: 'success' });
      const refresh = () => {
        if (username) {
          void queryClient.invalidateQueries({ queryKey: magiAssetsKey(username) });
          void queryClient.invalidateQueries({ queryKey: magiBtcKey(username) });
          void queryClient.invalidateQueries({ queryKey: ['walletSummary', username] });
          void queryClient.invalidateQueries({ queryKey: ['accountHistory', username] });
        }
        void queryClient.invalidateQueries({ queryKey: ['wallet', 'magiL1Balances'] });
      };
      refresh();
      for (const delay of RECHECK_DELAYS_MS) window.setTimeout(refresh, delay);
    },
    [queryClient, username, t]
  );

  const onError = useCallback((error: Error) => handleError(error, { method: 'magiSdkSwap', params: { username } }), [username]);

  return (
    <section className={CARD_CLASS} data-testid="wallet-magi-sdk-swap" id="magi-swap">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{t('wallet.magi.sdk.title')}</div>
          <p className="max-w-[620px] font-ui text-caption text-ink-10">{t('wallet.magi.sdk.description')}</p>
        </div>
        <span className="rounded-control bg-surface-23 px-2.5 py-1 text-caption font-medium text-ink-8" data-testid="wallet-magi-sdk-badge">
          {t('wallet.magi.sdk.badge')}
        </span>
      </div>
      {!config || !pools ? (
        <p className="mt-3 rounded-card border border-dashed border-line-11 px-4 py-3 font-ui text-caption text-ink-10" data-testid="wallet-magi-sdk-unavailable">
          {t('wallet.magi.sdk.unavailable')}
        </p>
      ) : (
        <>
          {!username ? (
            <p className="mt-3 font-ui text-caption text-ink-10" data-testid="wallet-magi-sdk-wallet-note">
              {t('wallet.magi.sdk.wallet_note')}
            </p>
          ) : null}
          <div className="mt-3 flex justify-center" data-testid="wallet-magi-sdk-widget">
            <MagiQuickSwap
              config={config}
              pools={pools}
              username={username}
              keyType="active"
              onBroadcast={username ? onBroadcast : undefined}
              onSuccess={onSuccess}
              onError={onError}
            />
          </div>
        </>
      )}
    </section>
  );
}
