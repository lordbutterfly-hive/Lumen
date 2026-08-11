export enum LoginType {
    hbauth = 'hbauth',
    keychain = 'keychain',
    peakvault = 'peakvault',
    metamask = 'metamask',
    google = 'google',
    hiveauth = 'hiveauth',
    wif = 'wif',
    hivesigner = 'hivesigner',
}

export enum KeyType {
    posting = 'posting',
    active = 'active'
}

export enum StorageType {
    localStorage = 'localStorage',
    sessionStorage = 'sessionStorage',
    memoryStorage = 'memoryStorage',
}

/**
 * Account tier for Lumen sessions.
 * 'full' = a real Hive account with client-side keys (legacy/default).
 * 'lite' = a Lumen proxy account (chosen name + user_id, NO Hive keys/wallet).
 * See LUMEN-LITE-ACCOUNTS-SPEC §A.5.
 */
export type AccountTier = 'lite' | 'full';

export type User = {
    isLoggedIn: boolean
    username: string
    avatarUrl: string
    loginType: LoginType;
    keyType: KeyType;
    authenticateOnBackend: boolean;
    chatAuthToken: string;
    oauthConsent: { [key: string]: boolean } // `key` is oauth client_id
    strict: boolean;
    /**
     * Lite-account fields. Optional and absent on legacy full-Hive sessions
     * (treated as 'full'), added non-breakingly so the ~101 existing `User`
     * call sites keep compiling. See spec §A.5.
     */
    userId?: string;              // permanent Lumen id; survives the ACT upgrade
    account_tier?: AccountTier;   // 'lite' keeps this session off the getSigner axis
}

export interface OAuthState {
    clientId: string;
    redirectUri: string;
    scope?: string;
    state?: string;
}

/**
 * Provisional state held between a verified lite auth (Google/BTC) and the
 * name-pick step, for a first-time user who has no account yet. Short-lived;
 * the auth-service enforces a TTL on `issuedAt`. See spec §A.1.
 */
export interface LiteSignupState {
    method: 'google_passkey' | 'btc_wallet' | 'evm_wallet';
    externalRef: string;            // google: verified sub; btc/evm: lower(address)
    network?: string;               // btc/evm only ('bitcoin' | 'testnet' | 'eip155')
    keyFingerprint?: string;        // btc only — hash160(pubkey); one key, one account
    emailCiphertextB64?: string;    // google only — envelope-encrypted, never rendered
    emailHash?: string;             // google only — abuse-blocklist join
    issuedAt: number;               // epoch ms, for TTL
}

export interface IronSessionData {
    user?: User;
    oauthState?: OAuthState;
    liteSignup?: LiteSignupState;   // present only mid-signup (lite accounts)
    /**
     * F-L38 (2026-08-11): epoch-ms timestamp for the server-enforced maximum age
     * of a FULL-HIVE session — the same problem F-L37's `sessionIssuedAt` solves
     * for lite sessions, for the tier that field deliberately does not cover.
     *
     * WHY THIS EXISTS. `packages/smart-signer/lib/session.ts` sets
     * `cookieOptions.maxAge: undefined` so closing the browser signs the user
     * out (an explicit owner requirement) — but iron-session 8.0.4 couples that
     * to seal `ttl = 0`, so iron-webcrypto embeds NO expiry inside the sealed
     * cookie VALUE either (see the byte-level proof in session.ts). A leaked
     * Hive cookie STRING therefore authenticated forever until this field
     * existed. See `getLiteSession()` in `apps/blog/lib/lite/http/session.ts`
     * for the enforcement (expire-if-stale, backfill-if-absent).
     *
     * ★ WHY IT IS NOT STAMPED AT ISSUE, unlike `sessionIssuedAt`. The one place
     * a full-Hive session is actually created —
     * `packages/smart-signer/lib/api-handlers/auth/login.ts` (plus the OAuth
     * consent/token and chat-token handlers) — calls
     * `getIronSession(req, res, sessionOptions)` DIRECTLY, never through
     * `getLiteSession()`, and none of those files were in scope for this fix.
     * `getLiteSession()` instead backfills this field the first time it reads a
     * Hive session carrying none — the only place within scope that can
     * legally persist a cookie mutation (a Route Handler context; it is
     * skipped, not thrown, when read from a Server Component render). This is
     * a REAL, STATED GAP: a Hive user whose browsing never reaches a route
     * that calls `getLiteSession()` (see that function's caller-list comment)
     * never gets backfilled, and the general `getIronSession(req, res,
     * sessionOptions)` call sites above never check this field at all. Closing
     * that fully needs an edit to `login.ts` and the other issuance/read sites,
     * which is out of this job's ownership.
     *
     * Optional, and MUST stay optional: every Hive cookie sealed before this
     * field existed — which today is every live one — carries none.
     */
    hiveSessionIssuedAt?: number;
}

export interface SiteConfigItem {
    value: any;
    description: string;
    userEditable: boolean;
}

export interface SiteConfig {
    appName: SiteConfigItem;
    apiEndpoint: SiteConfigItem;
}
