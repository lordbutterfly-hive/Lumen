import * as z from 'zod';
import { LoginType, KeyType } from '@smart-signer/types/common';
import { TTransactionPackType } from '@hiveio/wax';
import { username } from './utils';

/**
 * ★ SPLIT OUT OF `utils.ts` (2026-08-12) — DO NOT MERGE THIS BACK.
 *
 * `postLoginSchema` is a zod schema, so `pack: z.nativeEnum(TTransactionPackType)`
 * needs `TTransactionPackType` as a REAL VALUE at module scope, not just a type —
 * `z.nativeEnum()` cannot be called on a mere TypeScript type. That forces this
 * module's '@hiveio/wax' import to be a genuine runtime import, which pulls wax's
 * ~2.3 MB WASM-backed bundle into whatever chunk reaches this file.
 *
 * `postLoginSchema`'s only real consumer is the login API route
 * (lib/api-handlers/auth/login.ts, server-side, never bundled for the browser).
 * Everyone else only ever wanted the TYPE `PostLoginSchema`/`Signatures` — but
 * `utils.ts` also exports `defaultUser`, which `use-user-core.ts` needs
 * unconditionally on every page (to know if the visitor is signed in), via
 * `useUser`/`useUserClient`, reached from `SignerProvider`. Because a JS module's
 * top-level code runs in full on import regardless of which export a caller
 * asked for, keeping `postLoginSchema` inside `utils.ts` meant importing
 * `defaultUser` ALSO evaluated `z.nativeEnum(TTransactionPackType)` — reintroducing,
 * through an unrelated, unavoidable import, the exact wax leak fixed everywhere
 * else in this file's sibling modules (see packages/transaction/index.ts,
 * components/auth/process.tsx, lib/login-operation.ts).
 *
 * `PostLoginSchema`/`Signatures` are still consumed as TYPES from here by several
 * components (login-panel.tsx, signin-panel.tsx, condenser-migration.tsx, etc.) —
 * that is fine and unavoidable, but the type-only consumers (process.tsx,
 * use-sign-in.tsx, verify-login.ts) import with `import type` specifically so
 * this module's runtime code — and therefore `@hiveio/wax` — is never reached
 * from the pages that mount unconditionally.
 */
export const postLoginSchema = z.object({
  keyType: z.nativeEnum(KeyType, {
    invalid_type_error: 'Invalid keyType',
    required_error: 'keyType is required'
  }),
  loginType: z.nativeEnum(LoginType, {
    invalid_type_error: 'Invalid loginType',
    required_error: 'loginType is required'
  }),
  hivesignerToken: z.string({
    invalid_type_error: 'hivesignerToken must be a string',
    required_error: 'hivesignerToken is required'
  }),
  signatures: z.object({
    posting: z.string(),
    active: z.string()
  }),
  pack: z.nativeEnum(TTransactionPackType),
  strict: z.boolean(),
  txJSON: z.string(),
  authenticateOnBackend: z.boolean(),
  username
});
export type PostLoginSchema = z.infer<typeof postLoginSchema>;

export type Signatures = PostLoginSchema['signatures'];
