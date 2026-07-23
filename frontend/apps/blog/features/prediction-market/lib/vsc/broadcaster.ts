import { transactionService } from '@transaction/index';
import type { CustomJsonOp } from '../op-builders';
import type { Broadcaster } from '../vsc-market-data-source';

// The real broadcaster for the prediction market. VscMarketDataSource's
// broadcaster dependency existed (VscMarketDataSourceDeps.broadcaster) but was
// never supplied by getMarketDataSource() — so on any real (provisioned) build
// placeBet/claim threw NO_BROADCASTER_MSG. This file is the missing
// implementation, mirroring creator-tokens' lib/vsc/broadcaster.ts exactly (the
// two features share the same CustomJsonOp shape and Broadcaster signature).
//
// SIGNING STACK: `transactionService` (packages/transaction/index.ts, imported
// via the `@transaction/index` path alias — the same specifier
// apps/blog/features/wallet/lib/broadcast-raw-operation.ts already uses) is a
// plain module-level singleton, NOT a React hook, so it does not need to be
// called from component scope. Its `signerOptions` are populated as a side
// effect by <SignerProvider>, mounted once at the app root
// (apps/blog/features/layouts/providers.tsx), so by the time ANY write here
// runs the logged-in user's signing method (Keychain/HiveAuth/HiveSigner/
// password) is already wired. This function reads `transactionService` fresh on
// every call rather than capturing anything at construction time, so it works
// regardless of whether getMarketDataSource()'s singleton was created before or
// after the user logged in — the same reasoning documented in the creator-tokens
// broadcaster this mirrors.
//
// custom_json SHAPE: op-builders.ts's CustomJsonOp is exactly the four-field
// { id, json, required_auths, required_posting_auths } envelope
// @hiveio/wax's ITransaction.pushOperation wants inside a { custom_json_operation }
// wrapper (matches packages/transaction/index.ts's own markAllNotificationAsRead
// custom_json call), so `op` is passed straight through with no reshaping.
export const hiveTransactionBroadcaster: Broadcaster = async (op: CustomJsonOp) => {
  const result = await transactionService.processHiveAppOperation((builder) => {
    builder.pushOperation({ custom_json_operation: op });
  });
  return result.transactionId;
};
