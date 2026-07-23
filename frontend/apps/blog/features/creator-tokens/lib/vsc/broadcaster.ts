import { transactionService } from '@transaction/index';
import type { CustomJsonOp } from './op-builders';
import type { Broadcaster } from '../vsc-data-source';

// Finding C-B: the real broadcaster. VscCreatorTokensDataSource's
// broadcaster dependency existed (VscCreatorTokensDataSourceDeps.broadcaster)
// but was never supplied by getCreatorTokensDataSource() — every write threw
// NO_BROADCASTER_MSG on any real (provisioned) build. This file is the
// missing implementation.
//
// SIGNING STACK, verified directly against this repo's own code (not
// guessed): `transactionService` (packages/transaction/index.ts, imported
// here via the `@transaction/index` path alias apps/blog/tsconfig.json
// already maps to packages/transaction/index.ts — the same specifier
// apps/blog/features/wallet/lib/broadcast-raw-operation.ts already uses) is
// a plain module-level singleton, NOT a React hook — it does not need to be
// called from component scope. Its `signerOptions` are populated as a side
// effect by <SignerProvider>, mounted once at the app root
// (apps/blog/features/layouts/providers.tsx), so by the time ANY write here
// actually runs, whichever signing method (Keychain/HiveAuth/HiveSigner/
// password) the logged-in user configured is already wired — this function
// reads `transactionService` fresh on every call rather than capturing
// anything at construction time, so it works correctly regardless of
// whether getCreatorTokensDataSource()'s singleton was created before or
// after the user logged in (see that file's own doc for why this sidesteps
// the "broadcaster needs React context" assumption the original stub's
// comments made).
//
// custom_json SHAPE: confirmed against packages/transaction/index.ts's own
// existing custom_json call (markAllNotificationAsRead,
// `builder.pushOperation({ custom_json_operation: { id, json,
// required_auths, required_posting_auths } })`) — @hiveio/wax's
// `ITransaction.pushOperation` wants a `{ custom_json_operation: {...} }`
// envelope with EXACTLY the four fields op-builders.ts's CustomJsonOp
// already produces, so `op` is passed straight through with no reshaping.
export const hiveTransactionBroadcaster: Broadcaster = async (op: CustomJsonOp) => {
  const result = await transactionService.processHiveAppOperation((builder) => {
    builder.pushOperation({ custom_json_operation: op });
  });
  return result.transactionId;
};
