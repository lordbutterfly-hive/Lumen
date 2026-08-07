# Charter: a day as a regular reader

## Mission
You already have an account and you read here most days. Skim the feed, open a
few posts, reply, vote, reblog, chase a topic, look at somebody's profile, check
the bell and your wallet. Have a nice half hour and notice what spoils it.

Harness: `qa/harness/day-reader.mjs` — includes a `didItStick` helper, because
this reader's biggest complaint is things that quietly don't persist.

## Risk oracles
- **It didn't stick.** A reply, vote, reblog or follow that is gone after a
  reload, or that never appears where it should.
- **Small wrongness.** A count that disagrees with the list it labels, a stale
  number, a date that reads oddly, a name rendered as an id.
- **A slow moment with no explanation.** Time it, and say what you were looking
  at while you waited.
- **Somewhere the old site shows through** — different styling, chain jargon,
  a link that leaves Lumen.
