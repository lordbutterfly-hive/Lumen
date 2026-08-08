# The four oracles — how to find what the owner finds and we don't

Read this **in addition to** `_system.md`, `_honesty.md`, `_browser.md`, `_report.md`.

Across three rounds this harness found 25 + 7 + N real defects. It is good at
one shape of bug: **something on this page is broken.** A button 500s, a label
reads `undefined`, a spinner never resolves, a toast never fires.

The owner keeps finding a *different* shape, in minutes, that a whole fan-out of
testers walked past. Every one of those misses falls into one of four buckets,
and none of them is a matter of trying harder or clicking more. They are
structural: an exploratory tester driving one page, in one state, as one
identity, **cannot** see them. So each one below is turned into a mechanical
step you execute, not an instinct you are asked to have.

The four, with the real miss that named each:

| # | Oracle | What we missed | Why clicking harder would never have caught it |
|---|---|---|---|
| 1 | **ABSENCE** | NSFW posts rendering their images in the feed | Nothing failed. Settings offers `hide / warn / show`; the redesigned card simply never implemented it. There is no error to find — only a promise nobody checked |
| 2 | **CONTRADICTION** | `@taskmaster4450` read **Beacon** in the feed and **Torch** on his profile; a post read `in #hive-174301` on its page and `in Sketchbook` on its card | Each surface is individually plausible. The defect exists only in the *comparison*, and no single page shows both |
| 3 | **NO BASELINE** | "For You looks identical when I log in"; the Topics rail is the same for everyone | A feed that loads 20 real posts looks perfectly healthy. "Identical" is only visible against another run |
| 4 | **CONTAMINATION** | "For You shows test posts" — they were QA scratch rows; three charters filed "replies vanish" that was a paused publisher; a "Blocker" that was the coordinator rebuilding mid-run | The tester's own noise is indistinguishable from product behaviour unless provenance is tracked from the start |

**These four are now part of your charter whether or not your charter mentions
them.** A run that reports page-local bugs and skips these is a run that repeats
the last three.

---

## Oracle 1 — ABSENCE: check the promise, not the page

A promise is anything the product tells the user it will do: a setting, a
toggle, a labelled control, an empty state's claim, a banner's assertion.

**The step:** for every promise you encounter, write down *every surface where
that promise must hold*, then go and check each one. A promise honoured on the
page that makes it and ignored everywhere else is a High.

Worked example — the one that named this oracle:

> Settings offers **NSFW: hide / warn / show**.
> Surfaces that render posts: home feed (For You / Trending / Following),
> `/topics/<tag>`, profile Posts tab, search results, comment threads.
> Round 3 checked the setting page. Nobody checked the six surfaces.
> Four of them ignored it completely.

Promises worth walking today: NSFW preference · reward/payout preference ·
mute and blacklist · "hidden"/deleted posts · rate limits · the moderation
takedown · every banner that claims a background job is running.

**Ask, at every setting you find: "what would prove this is actually applied?"**
Then go prove it. If you cannot reach a surface, say so — an unchecked surface
is an unchecked surface, never a pass (`_honesty.md` rule 8).

## Oracle 2 — CONTRADICTION: keep a fact ledger

Every time a surface tells you a **fact about a named thing** — a rank, a
count, a price, a community name, a payout, a date, a follower total — record it.
One line per observation:

    node qa/harness/fact-ledger.mjs record \
      --run <your-run-id> --entity "@taskmaster4450" --attribute rank \
      --value "Beacon" --surface "home-feed-card" --url "https://localhost:3443/"

At the end of your run:

    node qa/harness/fact-ledger.mjs check --run <your-run-id>

It groups by `(entity, attribute)` and prints every group holding **more than
one distinct value**. Each of those is a contradiction: the product told the
same user two different things about one object in one session. Investigate
each, then report it with both surfaces quoted.

Record facts **as you go**, not from memory at the end. Memory is where
contradictions go to die — every one of them looked reasonable when you saw it.

## Oracle 3 — NO BASELINE: nothing is "personalised" until it differs

Any surface that claims to be for *you* — For You, Following, interest picks,
recommendations, topic rails, notifications — must be captured under **at least
two conditions** and compared. One capture proves nothing.

    # capture the same surface twice under different conditions
    node qa/harness/baseline-diff.mjs capture --run <id> --label anon      --url https://localhost:3443/
    node qa/harness/baseline-diff.mjs capture --run <id> --label signed-in --url https://localhost:3443/
    node qa/harness/baseline-diff.mjs compare --run <id> --a anon --b signed-in

It reports overlap and ordering distance between the two item lists.

Read the result honestly, in both directions:

* **Overlap ~100% on a surface that claims personalisation** → finding. This is
  the "identical logged in" bug, and it is invisible without this step.
* **Overlap ~0% between two runs of the SAME condition** → also a finding: the
  feed is churning and a reader loses their place.

Conditions worth pairing: anonymous vs signed-in · your identity vs another
agent's · before vs after picking interests · before vs after following someone
· first load vs reload 60s later.

## Oracle 4 — CONTAMINATION: prove it is the product, not you

Three of the loudest findings in the last two rounds were the harness's own
mess. The cost is not just the wasted triage — it is that a report which
contains one self-inflicted "Blocker" makes the human distrust the true
findings sitting next to it.

**Before the run:**

1. Record the build you are testing. Everyone shares one server:

       node qa/harness/build-guard.mjs stamp --run <your-run-id>

2. Use **your own identity**. Never the shared default account — two testers on
   one account cannot tell each other's state apart (this happened with
   `bravouyuce`).
3. Tag every piece of content you create with your run id, in the body.

**During the run:** before any observed post enters a finding, classify it:

* **MINE** — created by me this run (my run id is in it)
* **OTHER-AGENT** — QA-shaped content that is not mine (`QA`, `test`,
  `reproduction`, another run id, lorem text)
* **REAL** — genuine chain or user content

A finding about a feed's *contents* that does not state this classification is
not reportable. "For You shows test posts" is a **product** bug only if the
product is serving OTHER people's scratch data to a real reader — which is
exactly what it turned out to be, and stating the classification is what proves
it rather than assuming it.

**After the run:**

       node qa/harness/build-guard.mjs verify --run <your-run-id>

If the build changed underneath you, **your run is void** — say so at the top of
your report and re-run what you can. Do not file findings from a run whose
server was rebuilt mid-flight; that is what produced the phantom
`400 Bad Request` chunk "Blocker" last round.

Also confirm the **background jobs your flow depends on are actually running**
before you call something silent data loss. The publisher queue is the standing
example: three charters filed High/Blocker on "the reply vanished" when nothing
was draining the queue in that environment. One tester asked first, and was
right. **Ask first.**

---

## The debrief line this adds

Your PROOF debrief must now end with these four, answered explicitly:

* **ABSENCE** — which promises did I check, on which surfaces, and which surface
  did I fail to reach?
* **CONTRADICTION** — how many facts did I record, and what did `check` print?
* **BASELINE** — which surfaces did I capture under two conditions, and what was
  the overlap?
* **CONTAMINATION** — build stamp at start and end, my identity, and the
  MINE/OTHER-AGENT/REAL split of everything I cite.

"I did not do this one" is an acceptable answer and an honest one. Silently
skipping it is not.
