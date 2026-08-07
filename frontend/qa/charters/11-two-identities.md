# Charter: two people at once

## Mission
Run TWO different accounts (two browser contexts, two different private keys)
and cross-check everything one can see about the other. This oracle was named
last round and never reached.

## Risk oracles
- **Wrong person.** Any place account A sees account B's data, or its own chrome
  after switching — avatars, names, counts, drafts, session state.
- **Stale identity after logout.** Log A out in one context while B is active.
- **Actions attributed wrongly.** A votes/follows/replies; B must see it as A's,
  and A must not see it as B's.
- **A blocked or hidden thing leaking.** If you can moderate or delete, check the
  other account genuinely stops seeing it.
