# Charter: the API, asked directly

## Mission
Three rounds have driven the UI. Nobody has asked the 55 `/api/*` routes
themselves. A route does not stop existing because no button points at it —
auth, ownership, CSRF, rate limits and validation are enforced HERE, and anyone
can call them.

Harness: `qa/harness/api-probe.mjs` — two real identities, an anonymous caller,
and the full route inventory grouped by expected protection. Read it first.

## Risk oracles
- **A stranger can do something.** Any write, any private read, any privileged
  route reachable with no session. Try every write route anonymously.
- **A can act as B.** Give one identity's id/permlink to the other and see if it
  is accepted — edit, delete, vote, follow, moderate, read a private profile.
- **A guard that isn't there.** Missing CSRF header, wrong content-type, method
  not allowed, absent rate limit. Compare routes against their neighbours: if
  one lite write checks something and another doesn't, that gap is the finding.
- **What the error says.** A 500 with a stack trace, a raw chain assertion, a
  database message, or an id/email that should not be in a response body.

## Rules
- Act only on content YOUR identities created. Do not moderate, delete or
  publish anyone else's.
- Do not hammer: a few calls per route. Rate limits are real and shared.
- Report a clean route as clean — "I tried X anonymously and got 401" is a
  result worth having.
