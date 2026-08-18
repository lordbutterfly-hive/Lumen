# Lumen — status, 2026-08-18

Working tree: `/home/clauderfly/hive-blog-rebuild` (WSL). Serving build dir `.next-qa`.

> A second Claude session was editing the **retention** system in this same tree
> during this work (streak route, `compute-streak`, `today-card`, ladder tests).
> Three of my builds died on its in-flight files. Nothing below touches retention.

---

## 1. Keychain / Meritum launch — THE ANSWER

**Meritum cannot be launched with Keychain as currently configured, and it is not a bug in Lumen's signing code.**

### What was proven, and how

| Claim | Evidence |
|---|---|
| Lumen builds + broadcasts the launch on **Hive testnet** | `REACT_APP_CREATOR_TOKENS_HIVE_API=https://testnet.techcoderx.com`, chain id `18dcf0a2…`, read off the running server's own env |
| That node really is Hive testnet | `database_api.get_config` on it returns `HIVE_CHAIN_ID = 18dcf0a2…` |
| Magi testnet really does read Hive **testnet** | Magi GQL `localNodeInfo.last_processed_block = 5,793,819`; Hive testnet head `5,793,804`, Hive mainnet head `109,132,321` — it tracks testnet |
| The account and key are **not** the problem | `lordbutterfly` exists on both chains with the **same** active key `STM7xXFrx…` (it is a mainnet mirror) |
| Keychain signs against **its own** node, not ours | `@hiveio/wax-signers-keychain/dist/index.js:142` calls `requestSignTx(account, tx, role, cb)` — four arguments, omitting the 5th `rpc` |
| A Hive signature is bound to the chain id | Standard Hive; a mainnet-stamped digest recovers a different pubkey on testnet → `tx_missing_active_auth` (3010000) |

### Why it is genuinely hard

Keychain's own RPC module does `if (rpc.chainId) HiveTxConfig.chain_id = rpc.chainId`, and the testnet id in its source example is *exactly* ours. But the **public** `requestSignTx` API types the `rpc` argument as a plain **String** ("Override user's RPC settings"). So the chain id can only reach Keychain from **Keychain's own stored RPC configuration** — not reliably from a dApp call.

### What was done in code

1. Sign against the node we broadcast to — bypass `KeychainProvider` (which drops `rpc`) and call `requestSignTx` directly with the endpoint; try the `{uri, chainId}` object form first, fall back to the bare URI string.
2. **`verify_authority` now runs on the chain we broadcast to.** It previously ran on the app's global chain (mainnet), where a mainnet-signed transaction verifies fine — so the guard *passed* and let a doomed transaction through. That is why the first symptom was a chain rejection instead of a clear client-side refusal.
3. **Chain-id mismatch detector.** When verification fails on our chain, the same signed transaction is re-checked against the global chain. If mainnet accepts it, the key was never the problem — the signature was made for the wrong network — and the user is told exactly that, with the fix.
4. **Keychain's error text now survives.** Keychain rejects with a plain object, not an `Error`; it was being passed straight through, so the message extractor read `''` and the UI printed "Launch did not go through." with no reason. Now wrapped in a real `Error`.

### The two ways forward (owner's call)

- **A — Configure Keychain for the testnet.** Add `https://testnet.techcoderx.com` as a custom RPC in Keychain (Settings → Preferences → RPC nodes) **including chain id `18dcf0a285365fc58b71f18b3d3fec954aa0c141c44e4e5cb4cf777b9eab274e`**, select it, launch. Keeps Magi testnet. Downside: while selected, Keychain is pointed away from mainnet.
- **B — Move Meritum to Magi mainnet + Hive mainnet.** Keychain then signs natively with no configuration at all. This is the only option that makes Keychain "just work". Downside: real tokens, not test ones.

There is no third option that keeps Magi **testnet** and an unconfigured mainnet Keychain — the chain id makes it arithmetically impossible.

---

## 2. Fixed this session

### Money
- **Estimated account value was understated.** It summed `movableHp` (`HP owned − HP delegated out`). Delegated-out HP is still owned. Measured on the owner's account at HIVE $0.03803: shown **$4,638** vs actual **$5,126**; 12,855 HP (17.2%) silently dropped. Now uses `vestingHp` — not `netHp` (adds 7,503 HP delegated *in*, not owned), not `movableHp`.
- **HBD was valued at a hardcoded $1** while the hook already fetched the real rate ($0.941).

### Performance
- **Wallet ~6s.** `/api/wallet/summary` called `getAccountFull` = account read **plus** `bridge.get_profile`, whose `follow_stats`/`reputation` nothing in the wallet reads. That profile call fans out to one relationship lookup per banned author (6 configured) → **12 extra chain calls**, awaited on the slowest. Measured 0.42s–11.65s across real accounts vs a steady ~0.37s raw upstream. Now `getAccount`.
- **No retry on three hot paths.** `getDynamicGlobalProperties` (every wallet/profile/HP conversion waits on it) and both REST reads in the history route had none — history was caught returning a hard **502 after a 7.72s stall**. All wrapped in `withHiveRetry`.
- **Wallet waterfall.** History and delegations were mounted below the loading early-return, so they did not start fetching until balances resolved, despite depending on neither. Now start in parallel (same query keys, so it dedupes).
- **Topics ~12s.** Two causes. (a) The fallback fetched 50 posts against Hive's 20-per-call cap, and pagination cannot be parallelised (each cursor comes from the previous page) → **3 serial round trips at ~3.2s each**. Now fetches exactly one page; safe because this only builds page 1 and the list decides "is there more" from `nextCursor`, not page length. (b) **Topic warming was on by default until 2026-08-15, the default flipped to opt-in, and this deployment never set it** — so no per-tag cache was ever pre-filled. The template file explicitly warned this would happen silently. Measured cold: 5.5 / 7.8 / 9.4 / 12.7 / 14.7s across five tags; 6–8ms once warm.

### Notifications
- Panel had **no error branch at all** — a failed fetch rendered the same "No notifications yet" as a genuinely empty inbox, after 3 silent retries (~7s). Now a real error + retry, `retry: 1`.
- Verified the data itself is healthy for the owner's account: `unread: 3`, 50 rows returned. Both agent hypotheses (banned-author filtering, mismatched data sources) were checked and **disproved** against the live endpoints.

### Visuals
- **Bell** reverted to the line cut (owner rejected the filled one).
- **`post` icon** was a solid slab with detail painted in hardcoded cream `#fcfaf7` — read as a black bar under ~20px and inverted in dark mode. Rebuilt as a framed sheet with a real punched hole (`fill-rule="evenodd"`). Same treatment for `wallet`.
- **`comment` icon** was 100% solid ink and renders at **12px** in the notifications panel — now an outlined bubble.
- **`stake`** was byte-identical to `stack`; redrawn.
- **12 delivered icons wired** (23 → 35 of 106 slots). They already had components built; nothing pointed at them.
- **24 files converted off direct `lucide-react`** — the real reason the visible surface had not changed.
- **All 6 illustrations placed and inlined.** They were painted in hardcoded cream, so every one was broken in dark mode; Tailwind here is `darkMode: ['class']`, and an `<img>` cannot see the app's class, so they had to move into the DOM and onto theme tokens.

### Motion
- **Two regressions I had introduced, fixed.** The motion block was unlayered CSS, which beats every Tailwind utility regardless of specificity: it silently deleted the feed card's `hover:bg` fade and overrode a button deliberately built to *grow* on press so it shrank. Now inside `@layer utilities`, with longhands instead of the `transition` shorthand (which was resetting `transition-property`).
- **Press feedback was gated behind `@media (hover: hover)`** — so touch devices, the ones that actually press things, got none. Un-gated.
- **Press was half a gesture** — the transition was declared inside `:active`, so it animated down and snapped back. Moved to the resting state.
- Specificity lowered with `:where()` so a component can still override; stagger keyed to `nth-of-type` so banners no longer shift card delays.
- Motion extended to the classic post card (trending/hot/created).

### Errors
- **Funding failures now explain themselves.** Taking the first token spends real balance, and on Magi HBD is *also* the resource credit. A balance/RC failure now names the first-buy cost and renders the verified deposit route (transfer HBD to `@vsc.gateway` with an **empty memo** credits your own Magi account).

---

## 3. Not done

- **Browser verification of the visuals** — needs a stable tree; three builds were killed by the other session's files.
- **Staging** — `sync-frontend.sh` copies the whole tree with `--delete`, so staging now would also push the other session's half-finished retention work.
- Motion on comment list / profile lists (search already inherits it via the feed card).
- 3 unused motion tokens (`--ease-snap`, `--t-base`, `--lift-1`) and the unused `.lm-press` class.
- 6 icons deliberately left on lucide — `Gift`, `Sparkles`, `Smile`, `Flame`, `Activity`, `WifiOff`. No house equivalent exists; substituting a vaguely similar shape is worse than leaving them.
- 4 vote icons (`upvote`/`downvote` ± cast) deliberately unwired: the vote control is its own component the owner likes, and they cannot go through the filled-icon path, which hardcodes a fill and so cannot express the un-cast outline state.

## 4. Owner actions

1. **Decide A or B on the Keychain question above.** Nothing else unblocks the launch.
2. ~~**Set `FEED_TOPIC_WARM=yes` on the real server.**~~ **DONE.** There is no production server yet — local is the only one, and the warmer is live there, verified by its own log (`warmed 14/14 tags`, cycling every 10 min, 0 failed) rather than by the env var alone. When production exists it must be set there by hand: `.env.local` is excluded from the sync, so it cannot travel. Already enabled in `.env.blog.example`.
3. `/api/wallet/*` accepts any account name with no auth. The data is public on-chain so nothing leaks, but anyone can make the server do that work for any account — which mattered more when that work was 12 chain calls.
