# Charter: the app on a bad day

## Mission
Be the awkward user. Feed the app degenerate input and unusual navigation and
see what it admits to. Stay inside the product — no source edits, no server
restarts.

## Risk oracles
- **Unhandled anything.** `undefined`, `NaN`, `[object Object]`, a raw stack
  trace, an error code, or a blank white page.
- **Bad URLs.** Non-existent users (`/@thisdoesnotexist9999`), malformed
  permlinks, very long paths, unicode and emoji in the URL, missing query
  params on pages that need them.
- **Impossible values in forms.** Empty, whitespace-only, 10k characters,
  script tags, RTL text, zero-width characters. Nothing should be executed or
  reflected raw.
- **Fast hands.** Double-click submit, navigate mid-request, hit back during a
  load, open two tabs as the same account. Look for double posts and lost state.
