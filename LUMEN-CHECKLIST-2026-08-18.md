# Lumen — clear-the-decks checklist, 2026-08-18

Companion to `LUMEN-STATUS-2026-08-18.md` (which holds the full Keychain analysis).

---

## CLOSED

### Visual assets
| Item | State | Note |
|---|---|---|
| Bell icon | ✅ | Reverted to the line cut — the filled one was rejected on sight |
| `post` icon | ✅ | Was a solid slab with detail in hardcoded cream; read as a black bar under 20px and inverted in dark mode. Rebuilt as a framed sheet with a real punched hole |
| `wallet` icon | ✅ | Same hardcoded-cream fault; converted to `fill-rule="evenodd"`, identical in light, correct in dark |
| `comment` icon | ✅ | Was 100% solid ink and renders at **12px** in the notifications panel — read as a filled square. Now an outlined bubble |
| `stake` icon | ✅ | Was **byte-identical** to `stack`; redrawn as growth-from-a-base |
| Icon wiring | ✅ | 35 of the delivered set now reachable (was 23). The other 12 had components built but nothing pointed at them |
| lucide holdouts | ✅ | 37 files → 12. Those 12 are deliberate: 3 brand logos, 6 with no house equivalent, 1 spinner, 2 owned by the retention session |
| Illustrations placed | ✅ | All 6 live: comments, wallet, end-of-feed, notifications, search, 404 |
| Illustrations themed | ✅ | All were hardcoded cream = broken in dark mode. Tailwind here is `darkMode: ['class']` and an `<img>` cannot see that class, so they were **inlined** onto `--lm-illo-*` tokens. 0 hardcoded colours remain |
| **Vote blade alignment** | ✅ | **Owner report.** Ink occupies y 3.10–13.90 of a 0–24 box, so its centre is 8.50 against a box centre of 12 — the drawing sat **4.1px above** the line everything else aligns to. The down blade had the mirror fault (rotation is about the box centre, so it sat 4.1px low). Fixed by centring the artwork in the viewBox, which corrects both directions and adds no transform to contend with the cast animation |

### Motion
| Item | State | Note |
|---|---|---|
| Cascade-layer regression | ✅ | The motion block was **unlayered**, which beats every Tailwind utility regardless of specificity. It silently deleted the feed card's hover fade and made a button built to *grow* on press shrink instead. Now in `@layer utilities`, longhands instead of the `transition` shorthand (which was resetting `transition-property`) |
| Touch press feedback | ✅ | Was gated behind `@media (hover: hover)` — so touch devices, the ones that actually press things, got **none**. Un-gated |
| Press/release symmetry | ✅ | Transition was declared inside `:active`, so it animated down and snapped back. Moved to the resting state |
| Override-ability | ✅ | `:where()` drops specificity so a component can still set its own press |
| Stagger correctness | ✅ | `nth-child` counted banner siblings and shifted card delays; keyed to `nth-of-type` |
| Classic post card | ✅ | `lm-card` + `lm-enter` — trending/hot/created had no motion at all |
| Comment list | ✅ | `lm-enter` on comment rows |
| Dead tokens | ✅ | `--ease-snap`, `--t-base`, `--lift-1` had **0 consumers**; removed rather than left looking live |
| Dead `.lm-press` | ✅ | Existed in CSS with **0 elements using it**. Now wired to the anchor CTAs that need it — an `<a>` gets nothing from the `button:active` rule, which is exactly why the hook was written |

### Correctness
| Item | State | Note |
|---|---|---|
| Wallet estimated value | ✅ | Summed `movableHp` (owned − delegated out). Delegated-out HP is still owned. **$4,638 shown vs $5,126 real** — 12,855 HP (17.2%) dropped. Now `vestingHp` |
| HBD valuation | ✅ | Hardcoded at $1 while the real rate ($0.941) was already being fetched |
| Notifications panel | ✅ | See below — root cause found on the second pass |

### Performance (measured on this box)
| Surface | Before | After |
|---|---|---|
| `/api/wallet/summary` | 0.42–11.65s | **0.13–0.48s** |
| Cold topic feed | 5.5–14.7s | **0.38–0.68s** |
| Repeat topic | — | 5–8ms |

Causes: the wallet fetched `bridge.get_profile` it never reads, which fans out to one relationship call per banned author (6 configured = **12 extra chain calls**, awaited on the slowest); three hot paths had **no retry** (history was caught returning a hard 502 after a 7.7s stall); history and delegations were mounted below the loading return so they did not start until balances resolved. Topics: the fallback asked for 50 posts against Hive's 20-per-call cap and pagination cannot be parallelised → **3 serial trips**; plus topic warming defaulted to off on 2026-08-15 and this deployment never set it.

---

## OPEN — needs the owner

1. **Keychain / Meritum launch.** Talk to stoodkev. The ask is *not* "add testnet" — Keychain already does `HiveTxConfig.chain_id = rpc.chainId` internally, and the testnet id in its own source example is exactly ours. The gap is that the public `requestSignTx` documents `rpc` as a plain **string**, so a site cannot pass a chain id. Expect the diff to be small but the **review slow**, because "any website can tell your wallet which chain to sign for" is a security-sensitive surface they will want a prompt around. Given a custom RPC bricked the extension once already, **Option B (move Meritum to Magi mainnet, where Keychain signs natively with zero config) is the lower-risk path.**
2. **Set `FEED_TOPIC_WARM=yes` on the real server.** `.env.local` is excluded from `sync-frontend.sh`, so this cannot travel in the sync. Now enabled in `.env.blog.example` for fresh deployments. What it does: every 10 minutes a background timer pre-fetches the post list for the top ~60 topics into **RAM** (a `Map` capped at 200 entries — nothing is written to disk, nothing touches C:). Cost is outbound calls to the Hive node per cycle, which is why it is a flag.
3. **Feed quality — not touched, needs a decision.** The flower post that reached the For You feed pays **0.341 HBD** across **125 votes**, is not from anyone followed, sits in a community about petrol, and carries 9 unrelated tags (`pob, neoxian, pepe, waiv, leo, lolz, sportstalk…`). That is tag-farming. Grepped the feed route: there is **no dust-vote floor, no minimum payout, and no tag-spam check** anywhere. Vote *count* is being read as signal when vote *value* is what separates real engagement from farming. A payout-per-vote floor would drop it without hurting genuine small creators. **Not implemented — ranking changes need your go.**

---

## NOT DONE, deliberately

- 4 vote icons (`upvote`/`downvote` ± cast) left unwired: the vote control is its own component, and they cannot go through the filled-icon path, which hardcodes a fill and so cannot express the un-cast outline state.
- 6 lucide icons kept (`Gift`, `Sparkles`, `Smile`, `Flame`, `Activity`, `WifiOff`): no house equivalent exists; a vaguely-similar substitute is worse than the honest original.
- `/api/wallet/*` accepts any account name with no auth. Data is public on-chain so nothing leaks, but anyone can make the server do that work for any account.

---

## Staging

`sync-frontend.sh` copies the whole tree with `--delete`, so it is **not** safe to run while the retention session has work in flight. Stage with the script's excludes **plus**:

```
--exclude='apps/blog/features/retention/'
--exclude='apps/blog/lib/lite/retention/'
--exclude='apps/blog/app/api/streak/'
--exclude='apps/blog/app/api/retention/'
--exclude='apps/blog/lib/lite/repositories/hive-retention-repository.ts'
--exclude='apps/blog/lib/lite/db/migrations/0037_drop_goal_and_freeze.sql'
--exclude='apps/blog/lib/lite/db/migrations/0038_hive_authored_volume.sql'
```

Excluded files are protected from `--delete` on the receiving side, so their repo copies survive untouched. Also owned by that session and left alone: `manabar-ring.tsx`, `right-rail.tsx`, `home-shell.tsx`, and the `retention.*` namespace in `locales/en/common_blog.json` (my two notification keys live under `navigation.profile_notifications_tab_navbar` in the same file — merge, do not overwrite).
