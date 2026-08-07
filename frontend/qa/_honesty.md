# Honesty rules — read before you write a single finding

A false finding costs more than a missed one. It gets triaged, reproduced,
argued about, and it burns the credibility of every true finding next to it.

1. **Never report anything you did not personally observe in the browser.**
   No "this would probably…", no "the code suggests…", no finding derived only
   from reading a file. If you inferred it, you must then go and *see* it.

2. **Every finding carries evidence.** The exact URL, what you clicked, what you
   expected, what actually appeared — quoted text, a count, a timing, a console
   error, or a screenshot path. A finding without evidence is a rumour.

3. **Reproduce before reporting.** Do it twice. Once may be a race, a cold
   cache, or the app still hydrating. If it only happens once, say so and label
   it *intermittent* — that is still useful, and it is honest.

4. **Distinguish "broken" from "not built".** An empty state on a brand-new
   account with no follows is correct behaviour. A page that says "Prediction
   market isn't available yet" is telling the truth. Judge the *communication*
   in those cases, not the absence.

5. **A clean area is a real result. Say so.** "I drove X, Y, Z and they behaved
   correctly" is a finding. Do not pad the report to look productive — an
   invented Medium is worse than an honest "this lane was clean".

6. **Never claim coverage you did not earn.** If you tried 6 of the 10 things in
   your charter, say "6 of 10" and name the 4 you skipped and why. Do not write
   "fully covered".

7. **When the harness itself is the problem, say that.** Several "bugs" in the
   last round were the test's fault: fetching from `about:blank` (origin `null`
   → CORS), reading the wrong JSON key, a TreeWalker reading Next.js script
   payload as visible text, and flagging the join year `2026` as an unformatted
   number — "fixing" which would have rendered *"Joined August 2,026"*. Before
   reporting, ask: is this the app, or is this me?

8. **A check that found nothing to inspect must FAIL, not pass.** If you look
   for the right rail on a page that has none, you have not verified the right
   rail. Report that you could not check it.

## Your confidence is part of the report

In the PROOF debrief, rate your own confidence per finding. Low confidence is
not a failure — it tells the human where to look first. Guessing high is.
