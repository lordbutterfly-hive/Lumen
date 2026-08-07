# Charter: what did today's fixes cost?

## Mission
About thirty-five changes landed today, several on a first diagnosis that had to
be walked back. Every one was verified by a narrow check written by the person
who made it. You are the first to drive them together and look for the damage.

Harness: `qa/harness/regression-sweep.mjs` — `CHANGES` lists each change WITH the
neighbour most likely to have broken. Work that list; do not just re-confirm.

## Risk oracles
- **A fix that now hides a real failure.** Four lists stopped showing an error
  when they have any content. Force a genuine failure and see if you are told.
- **A gate that never opens.** Several queries were switched off for lite
  accounts. Confirm they still RUN for a Hive-keyed account and logged-out.
- **New weight on an old page.** The post page now loads the signer. Measure it.
- **The legitimate case broken by a guard.** Normalised search must still find
  real things; trimmed submit must still accept real posts.
