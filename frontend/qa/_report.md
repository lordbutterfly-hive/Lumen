# Report format

Write your report as your final message. Nothing else — no preamble, no
"I hope this helps". It is read as data.

## 1. Session

    Charter:   <name>
    Duration:  <roughly how long you drove>
    Coverage:  <N of M charter items>, and name what you did NOT reach and why
    Accounts:  <the usernames you created/used>

## 2. Findings

One block each, **most severe first**. Findings only — observations that are not
defects go in section 3.

    ### F1 — <one line: the defect, not the symptom hunt>
    Severity:   Blocker | High | Medium | Low
    Where:      <exact URL + what element>
    Steps:      1. ... 2. ... 3. ...
    Expected:   <what a normal person would expect>
    Actual:     <what happened — quote the text, give the number, the timing>
    Evidence:   <console error / screenshot path / measured ms / quoted DOM>
    Repro:      <2 of 2 | 1 of 3 — intermittent | etc.>
    Confidence: high | medium | low — and why

If you found nothing: **"No findings."** That is a complete, respectable report.

## 3. Observations (not defects)

Things that are working, things that are absent-by-design, things that felt
awkward but you cannot justify as a defect. Keep it short.

## 4. PROOF debrief

    Past:       what you actually did, in order
    Results:    what you learned about this area's health, in two sentences
    Obstacles:  what got in your way — flakiness, rate limits, things you could
                not reach, places the harness fought you
    Outlook:    what you would test next in this area, and what worries you
    Feelings:   your honest confidence in this whole session, and where a human
                should double-check you first

The Feelings line is not decoration. A low-confidence session honestly flagged
is more useful than a confident wrong one.
