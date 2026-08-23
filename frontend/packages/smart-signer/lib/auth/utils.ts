import * as z from 'zod';
import { validateHiveAccountName } from '@smart-signer/lib/validators/validate-hive-account-name';
import { LoginType, User, KeyType } from '@smart-signer/types/common';

// ★ `postLoginSchema`/`PostLoginSchema`/`Signatures` moved to ./login-schema.ts
// (2026-08-12) — DO NOT bring them back here. That schema needs
// `TTransactionPackType` as a real runtime VALUE from '@hiveio/wax' to build
// `z.nativeEnum(...)`, and this file's `defaultUser` below is on the static
// import path of `use-user-core.ts` — reached, unconditionally, from every page
// via SignerProvider's `useUser`/`useUserClient`. Keeping the wax-dependent
// schema in the SAME module as `defaultUser` meant every page's unavoidable
// need for `defaultUser` also evaluated that schema, and with it wax's ~2.3 MB
// WASM-backed bundle — see login-schema.ts's header comment for the full trace.

export const username = z.string()
    .superRefine((val, ctx) => {
        const result = validateHiveAccountName(val, (v) => v);
        if (result) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: result,
                fatal: true,
            });
            return z.NEVER;
        }
        return true;
    });

export const defaultUser: User = {
    isLoggedIn: false,
    username: '',
    avatarUrl: '',
    loginType: LoginType.hbauth,
    keyType: KeyType.posting,
    authenticateOnBackend: true,
    strict: false,
};
