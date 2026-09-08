/**
 * The one configuration this app must never run in silently: a TESTNET Magi
 * network beside a MAINNET Hive L1.
 *
 * ★ WHY (2026-09-08, found live by a tester). The Hive L1 endpoint and chain id
 * default to mainnet when unset (packages/ui/config/public-vars.ts:22,
 * packages/ui/config/site.ts:18), and production relies on that default
 * (.env.lumen-mainnet.example marks REACT_APP_API_ENDPOINT optional). A QA
 * instance provisioned for the Magi TESTNET (REACT_APP_CREATOR_TOKENS_NET_ID=
 * vsc-testnet) that leaves those two unset therefore reads AND SIGNS Hive L1
 * on mainnet: the wallet's own Send / power / savings dialogs would move real
 * funds under a testnet banner. Nobody broadcast, by luck.
 *
 * WHY NOT "require the vars": that would break production, which is correctly
 * on the default. The invariant that matters is CONSISTENCY between the two
 * networks, so that is what is asserted, at boot, and it can only be crossed
 * on purpose with LUMEN_ALLOW_MIXED_NETWORKS=yes (a deliberate "feeds on
 * mainnet, Magi on testnet, and I know the Hive money dialogs sign mainnet"
 * setup, which some QA stacks use). Pure function, so it can be self-tested.
 */
export const HIVE_MAINNET_CHAIN_ID = 'beeab0de00000000000000000000000000000000000000000000000000000000';

export interface NetworkConsistency {
  ok: boolean;
  /** Human-readable verdict; the reason when not ok. */
  message: string;
}

export function checkNetworkConsistency(env: Record<string, string | undefined>): NetworkConsistency {
  const magiNet = (env.REACT_APP_CREATOR_TOKENS_NET_ID ?? '').trim();
  const l1ChainId = (env.REACT_APP_CHAIN_ID ?? '').trim() || HIVE_MAINNET_CHAIN_ID;
  const l1Endpoint = (env.REACT_APP_API_ENDPOINT ?? '').trim() || 'https://api.hive.blog (default)';
  const l1IsMainnet = l1ChainId === HIVE_MAINNET_CHAIN_ID;
  const override = (env.LUMEN_ALLOW_MIXED_NETWORKS ?? '').trim().toLowerCase() === 'yes';

  if (!magiNet) {
    return { ok: true, message: `network check: Magi not provisioned; Hive L1 ${l1IsMainnet ? 'mainnet' : 'non-mainnet'} (${l1Endpoint})` };
  }
  if (magiNet === 'vsc-testnet' && l1IsMainnet) {
    const msg =
      `network check: REACT_APP_CREATOR_TOKENS_NET_ID=vsc-testnet but the Hive L1 chain is MAINNET ` +
      `(REACT_APP_CHAIN_ID ${env.REACT_APP_CHAIN_ID ? 'set to mainnet' : 'unset, defaulting to mainnet'}, endpoint ${l1Endpoint}). ` +
      `The wallet's Hive dialogs would sign REAL mainnet transactions under a testnet Magi. ` +
      `Set REACT_APP_API_ENDPOINT and REACT_APP_CHAIN_ID to the Hive testnet the Magi testnet reads, ` +
      `or set LUMEN_ALLOW_MIXED_NETWORKS=yes to run this mix on purpose.`;
    return override ? { ok: true, message: `${msg} (ALLOWED by LUMEN_ALLOW_MIXED_NETWORKS=yes)` } : { ok: false, message: msg };
  }
  if (magiNet === 'vsc-mainnet' && !l1IsMainnet) {
    const msg =
      `network check: REACT_APP_CREATOR_TOKENS_NET_ID=vsc-mainnet but the Hive L1 chain id is not mainnet ` +
      `(REACT_APP_CHAIN_ID=${l1ChainId.slice(0, 8)}…, endpoint ${l1Endpoint}). A mainnet Magi cannot be fed from a non-mainnet L1.`;
    return override ? { ok: true, message: `${msg} (ALLOWED by LUMEN_ALLOW_MIXED_NETWORKS=yes)` } : { ok: false, message: msg };
  }
  return { ok: true, message: `network check: Magi ${magiNet}, Hive L1 ${l1IsMainnet ? 'mainnet' : 'non-mainnet'} (${l1Endpoint}); consistent` };
}
