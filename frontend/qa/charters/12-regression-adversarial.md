# Charter: try to break today's fixes

## Mission
A list of eleven things were fixed today (see the ★ list in `_browser.md`).
Your job is to find where each fix is INCOMPLETE — a neighbouring path the fix
did not reach. Do not simply confirm them; attack the edges.

## Risk oracles
- **The same bug one door along.** e.g. search survives an apostrophe — does it
  survive one in an AUTHOR search, a tag search, a very long query? Publishing
  confirms from the composer and the editor — does an EDIT confirm? A reply?
- **The fix moved the problem.** A guard that now hides something that should
  have shown; an empty state where real content belongs.
- **The fix is cosmetic.** The message changed but the underlying request still
  fails, retries, or costs seconds.
- **Only one tier was fixed.** Most of these bugs were lite-vs-Hive account
  differences. For each fix, check the OTHER kind of account and the logged-out
  visitor too.
