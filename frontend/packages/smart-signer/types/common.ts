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
    method: 'google_passkey' | 'btc_wallet';
    externalRef: string;            // google: verified sub; btc: lower(address)
    network?: string;               // btc only
    emailCiphertextB64?: string;    // google only — envelope-encrypted, never rendered
    emailHash?: string;             // google only — abuse-blocklist join
    issuedAt: number;               // epoch ms, for TTL
}

export interface IronSessionData {
    user?: User;
    oauthState?: OAuthState;
    liteSignup?: LiteSignupState;   // present only mid-signup (lite accounts)
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
