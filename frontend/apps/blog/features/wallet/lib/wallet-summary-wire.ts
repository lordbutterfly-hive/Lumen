import type { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import type { WalletFiguresWire } from './wallet-figures-wire';

/**
 * The shape `/api/wallet/summary` sends, and what `app/wallet/page.tsx` now
 * builds server-side too (T3g, 2026-09-04) so the wallet can SSR-seed it.
 *
 * Pulled out on its own for the same reason `wallet-figures-wire.ts` is its
 * own module and not part of `wallet-derived.ts`: it must stay importable
 * from CLIENT code (`use-wallet-account.ts`, `wallet-summary-context.tsx`)
 * with zero risk of dragging `@transaction/lib/chain`'s `Chain` type - and
 * the wax runtime behind it - into the browser bundle. Every import below is
 * `import type`, so this file has no runtime footprint at all; the actual
 * chain reads live in `wallet-summary-seed.ts` (server-only).
 */
export interface WalletSummaryWire {
  account: FullAccount;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse;
  figures: WalletFiguresWire;
  pendingClaimedAccounts: number;
}
