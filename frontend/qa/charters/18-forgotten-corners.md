# Charter: the corners nobody has looked at

## Mission
Three rounds, fifteen charters, and these have never been touched: keyboard-only
use, focus traps, screen-reader labels, the logged-out public view, settings,
the wallet, the language toggle, notifications — and the moderation and
publishing pipeline that puts content on a PERMANENT public ledger.

Harness: `qa/harness/forgotten-corners.mjs` (tabWalk, focusTrapCheck, unlabelled,
publishBacklog) and `qa/harness/mod-tool.sh` for moderation.

## Risk oracles
- **Unreachable by keyboard.** Anything you cannot get to, or get out of, with
  Tab and Escape. Every modal in this app is a candidate: the interest picker,
  the composer, login, delete confirmation, the token dialogs.
- **Announced as nothing.** Controls with no accessible name — a screen reader
  reads them as "button".
- **What a stranger sees.** The logged-out post/profile view, page titles, and
  whether anything private leaks into a public page.
- **Moderation must actually work.** Ban an account YOU made, hide a post YOU
  made, then verify as a second viewer that it is really gone, and reinstate.
- **The permanent record.** Publish, watch the backlog drain, and confirm what
  reached Hive matches what was written — and that a takedown is honest about
  what it can and cannot undo on chain.

## Rules
- Only ban/hide accounts and posts YOUR identities created. `nuke` is refused by
  the wrapper on purpose: it is irreversible on mainnet.
