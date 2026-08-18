/**
 * ════ ANTI-CHEAT: MAKING A GREEN RUN MEAN SOMETHING ════
 *
 * ★★★ THE PROBLEM THIS SOLVES, STATED PLAINLY.
 *
 * When one agent, in one session, with one goal ("make it pass"), writes both the code
 * and the test, the test stops being an independent check. The documented failure modes
 * are not hypothetical — they are what agents measurably do:
 *
 *   - assert on a mock instead of the real unit (36% of agent test commits add mocks vs
 *     26% for humans — MSR 2026, 1.2M commits across 2,168 repos)
 *   - widen a tolerance until the failure disappears (0.01 -> 0.5)
 *   - weaken an assertion to "any error exists"
 *   - `.skip` a failing test rather than fix it
 *   - regenerate a snapshot to match new, possibly wrong, output
 *   - raise an expectation from 20 to 50,000 to make a broken pagination feature pass
 *
 * None of those are caught by "the tests are green". They ARE caught by looking at the
 * shape of the test diff, which is what this file does.
 *
 * ★ IT IS NOT A LINTER FOR STYLE. Every check here answers one question: could this
 * change make the suite weaker without anyone noticing?
 */

import { execSync } from 'node:child_process';

/**
 * Patterns that weaken a suite. Each is a real, documented agent behaviour.
 *
 * `severity: 'block'` means the change must not merge without a human explicitly
 * acknowledging it. `'warn'` means surface it in review.
 */
export const WEAKENING_PATTERNS = [
  /**
   * ★★★ THESE PATTERNS SURVIVE REFORMATTING (D1, 2026-08-18).
   *
   * The first versions were `\b(test|it|describe)\.(skip|todo)\b` - the modifier had to
   * sit on the same line, directly after the keyword, with no space. Every one of these
   * slips straight past that, and none of them is exotic:
   *
   *     it . skip('x')            a space around the dot
   *     it['skip']('x')           bracket access, valid JS
   *     it\n  .skip('x')          Prettier's own output when the line is long
   *
   * The last one is the dangerous case, because nobody has to intend it: a formatter can
   * produce it while reflowing an unrelated edit. A gate that a formatting pass can
   * silently disarm is not a gate.
   *
   * The continuation form is matched on its own - an added line that is nothing but
   * `.skip(` or `.only(` has no other meaning in a test file.
   */
  {
    id: 'skipped-test',
    re: /^\+.*\b(test|it|describe)\s*(\.\s*(skip|todo)\b|\[\s*['"](skip|todo)['"]\s*\])|^\+\s*(xit|xdescribe)\b|^\+\s*\.\s*(skip|todo)\s*\(/,
    severity: 'block',
    why: 'A skipped test is a deleted check wearing a test\'s clothes. Quarantine tracks and re-runs; .skip just stops asking.'
  },
  {
    id: 'focused-test',
    re: /^\+.*\b(test|it|describe)\s*(\.\s*only\b|\[\s*['"]only['"]\s*\])|^\+\s*(fit|fdescribe)\b|^\+\s*\.\s*only\s*\(/,
    severity: 'block',
    why: '.only silently shrinks the whole suite to one test while still reporting green.'
  },
  {
    id: 'assertion-aliased',
    re: /^\+\s*(const|let|var)\s+\w+\s*=\s*(expect|assert)\b\s*;?\s*$/,
    severity: 'warn',
    why: 'An assertion function was aliased to another name. Legitimate occasionally; also the simplest way to make every other pattern in this file blind, since they all match on the literal word.'
  },
  {
    id: 'snapshot-regenerated',
    re: /^\+\+\+ .*\.snap$/,
    severity: 'block',
    why: 'Updating a snapshot converts a regression check into a test that passes after any change. Needs a human to confirm the NEW output is correct.'
  },
  {
    /**
     * ★★ INLINE SNAPSHOTS EVADED THE RULE ABOVE ENTIRELY (D2, 2026-08-18). It matches the
     * FILE HEADER of a `.snap`, so it only ever sees external snapshots. An inline
     * snapshot lives in the test file itself and is rewritten in place by `--ci=false`,
     * which is the same "regenerate until green" move with none of the visibility - there
     * is no separate artefact for a reviewer to notice changing.
     */
    id: 'inline-snapshot-written',
    re: /^\+.*toMatch(Inline)?Snapshot\s*\(\s*[`'"]/,
    severity: 'warn',
    why: 'An inline snapshot was written or rewritten. Same risk as regenerating a .snap file, with less visibility: confirm the NEW expected output is correct.'
  },
  {
    id: 'tolerance-widened',
    /**
     * ★ THE REALISTIC SHAPE IS NOT A BARE LITERAL (D4, 2026-08-18). The old pattern
     * required a DIGIT immediately after the paren, so it saw `toBeCloseTo(0.5)` and
     * missed `toBeCloseTo(computed(), 2)` - the far more common form, where the precision
     * that got loosened is the SECOND argument. Now any touch of these names reports; a
     * warn that occasionally fires on an innocent edit is the right trade for a rule whose
     * whole job is noticing a number quietly getting bigger.
     */
    re: /^\+.*\b(toBeCloseTo|toMatchCloseTo|maxDiffPixel\w*|threshold|tolerance|timeout)\s*[:(]/,
    severity: 'warn',
    why: 'A tolerance or timeout was touched. Widening one is the cheapest way to make a real failure disappear.'
  },
  {
    id: 'truthiness-only',
    re: /^\+\s*expect\([^)]*\)\.(toBeTruthy|toBeDefined|not\.toBeNull)\(\)\s*;?\s*$/,
    severity: 'warn',
    why: 'Asserting only that something exists says nothing about whether it is right. This is the shape of a test written to pass.'
  },
  {
    id: 'mock-asserted',
    re: /^\+\s*expect\((mock|stub|spy|jest\.fn)/i,
    severity: 'warn',
    why: 'Asserting on the mock tests the mock, not the code. The classic over-mocked-agent-test signature.'
  },
  {
    id: 'passWithNoTests',
    re: /^\+.*passWithNoTests\s*[:=]\s*true/,
    severity: 'block',
    why: 'Makes an empty run PASS. An empty run must always fail — it is indistinguishable from a misconfigured one.'
  },
  {
    id: 'allowOnly',
    re: /^\+.*allowOnly\s*[:=]\s*true/,
    severity: 'block',
    why: 'Lets a stray .only shrink CI to one test without failing.'
  },
  {
    id: 'harness-count-lowered',
    re: /^\+.*EXPECTED_PAGE_COUNT\s*=\s*\d+/,
    severity: 'warn',
    why: 'The sweep\'s coverage tripwire moved. Legitimate when routes change; a silent way to narrow coverage otherwise.'
  }
];

/**
 * ════ ASSERTION REMOVAL, COUNTED PER HUNK (D3, 2026-08-18) ════
 *
 * ★★★ WHY THIS IS NO LONGER A LINE PATTERN.
 *
 * `assertion-removed` used to live in `WEAKENING_PATTERNS` as `/^-\s*(expect|assert)\(/`
 * — every REMOVED line starting with an assertion, flagged as BLOCK. On the live working
 * tree that produced **235 hits**, and essentially all of them were assertions that the
 * very next line put back in edited form:
 *
 *     -  expect(streak).toBe(3);
 *     +  expect(streak.streakDays).toBe(3);
 *
 * That is a diff renaming a field. A unified diff has no way to express "changed"; it
 * expresses it as remove-then-add, so a rule that looks only at `-` lines cannot tell an
 * EDIT from a DELETION. It called 235 edits deletions.
 *
 * ★ AND THAT IS WORSE THAN MISSING THE BUG. 235 block-severity hits on a clean diff is a
 * gate nobody can read, so the next person turns it off or scrolls past it — and a real
 * smuggled deletion goes through inside the noise. A check that cries wolf has negative
 * value; it does not merely fail to help.
 *
 * ★ WHAT IT DOES NOW. It pairs within each HUNK, which is the unit a diff actually
 * guarantees is a coherent edit: count assertions removed and assertions added in the
 * same hunk, and report only the EXCESS removals. A hunk that removes three and adds
 * three is a rewrite and is silent. A hunk that removes three and adds none is a
 * deletion and is reported, with the count.
 *
 * ★ A LEGITIMATE DELETION STILL REPORTS, ON PURPOSE. Deleting an obsolete module really
 * does remove assertions, and that must be visible in review — it just must not be
 * indistinguishable from someone quietly dropping a check that started failing.
 */
const ASSERTION_RE = /^([+-])\s*(expect|assert|check)\s*\(/;

export function findAssertionDeletions(diff) {
  const lines = diff.split('\n').filter((l) => !isCommentLine(l) || /^\+\+\+|^---|^@@/.test(l));
  const findings = [];
  let file = '';
  let inTestFile = false;
  let removed = 0;
  let added = 0;
  let hunkHeader = '';

  const flush = () => {
    if (inTestFile && removed > added) {
      findings.push({
        id: 'assertion-removed',
        severity: 'block',
        why: `${removed - added} assertion(s) removed and not replaced in this hunk. A behaviour change should REPLACE an assertion, not drop it.`,
        file,
        line: hunkHeader
      });
    }
    removed = 0;
    added = 0;
  };

  for (const line of lines) {
    const fm = line.match(/^\+\+\+ b\/(.*)$/);
    if (fm) {
      flush();
      file = fm[1];
      inTestFile = TEST_PATHS.test(file);
      hunkHeader = '';
      continue;
    }
    if (line.startsWith('@@')) {
      flush();
      hunkHeader = line.slice(0, 120);
      continue;
    }
    const m = line.match(ASSERTION_RE);
    if (!m) continue;
    if (m[1] === '-') removed++;
    else added++;
  }
  flush();
  return findings;
}

/** Paths whose changes are, by definition, changes to the checks themselves. */
const TEST_PATHS = /(__tests__|\.test\.|\.spec\.|playwright\/|qa\/harness\/)/;

/**
 * Scan a unified diff for weakening changes.
 *
 * @param {string} diff  output of `git diff`
 */
/**
 * ★★★ COMMENT LINES ARE STRIPPED BEFORE SCANNING (fixed 2026-08-18, and it was misfiring
 * on this repo's REAL diff, not a synthetic one).
 *
 * Run against the live working tree, `scanDiff` produced 251 BLOCK hits — and 11 of the 16
 * `skipped-test` hits were DOC COMMENTS describing a `.skip` that had been REMOVED, e.g. a
 * comment explaining "every caller turned that null into `test.skip(...)` — so the one
 * signal it produced was converted into a green skip". A comment explaining a fix, flagged
 * as if it introduced the bug.
 *
 * A ~69% false-positive rate on real data does not make a gate strict, it makes it
 * ignored — and an ignored gate is how a real smuggled `.skip` gets waved through. The
 * IACVT detector already learned this exact lesson and strips comments for the same
 * reason; that lesson simply had not been applied here.
 *
 * Only added/removed lines whose CONTENT is a comment are dropped. A `.skip` on a line
 * that also has code is still caught.
 */
function isCommentLine(line) {
  const body = line.replace(/^[+-]/, '').trim();
  return body.startsWith('*') || body.startsWith('//') || body.startsWith('/*') || body.startsWith('#');
}

export function scanDiff(diff) {
  const lines = diff.split('\n').filter((l) => !isCommentLine(l) || /^\+\+\+|^---/.test(l));
  const hits = [];
  let currentFile = '';

  for (const line of lines) {
    const fileMatch = line.match(/^\+\+\+ b\/(.*)$/);
    if (fileMatch) currentFile = fileMatch[1];

    for (const p of WEAKENING_PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ id: p.id, severity: p.severity, why: p.why, file: currentFile, line: line.slice(0, 160) });
      }
    }
  }
  return hits;
}

/**
 * Count assertions added vs removed in test files.
 *
 * ★ THE SINGLE HIGHEST-SIGNAL NUMBER IN A REVIEW. A change that removes more assertions
 * than it adds has made the suite weaker, whatever its commit message says. It is not
 * automatically wrong — deleting a whole obsolete module legitimately removes hundreds —
 * but it must never pass unremarked.
 */
export function assertionDelta(diff) {
  const lines = diff.split('\n').filter((l) => !isCommentLine(l) || /^\+\+\+|^---/.test(l));
  let added = 0;
  let removed = 0;
  let inTestFile = false;

  for (const line of lines) {
    const fileMatch = line.match(/^\+\+\+ b\/(.*)$/);
    if (fileMatch) inTestFile = TEST_PATHS.test(fileMatch[1]);
    if (!inTestFile) continue;
    if (/^\+\s*(expect|assert|check)\s*\(/.test(line)) added++;
    if (/^-\s*(expect|assert|check)\s*\(/.test(line)) removed++;
  }
  return { added, removed, net: added - removed };
}

export function run(baseRef = 'HEAD') {
  let diff = '';
  try {
    diff = execSync(`git diff ${baseRef}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    console.error(`could not read diff against ${baseRef}: ${err.message}`);
    process.exit(2);
  }

  // ★ AN EMPTY DIFF IS NOT A PASS. It means the check had nothing to inspect, which is a
  // different statement from "the change is clean" — and reporting the second when the
  // first is true is exactly the vacuous pass this harness exists to prevent.
  if (diff.trim().length === 0) {
    console.log('anti-cheat: NOTHING TO INSPECT (empty diff). This is not a pass.');
    process.exit(3);
  }

  const hits = [...scanDiff(diff), ...findAssertionDeletions(diff)];
  const delta = assertionDelta(diff);

  console.log(`anti-cheat: scanned ${diff.split('\n').length} diff lines`);
  console.log(`assertions in test files: +${delta.added} -${delta.removed} (net ${delta.net >= 0 ? '+' : ''}${delta.net})`);

  if (delta.net < 0) {
    console.log(`\n⚠ THE SUITE GOT WEAKER: ${-delta.net} more assertions removed than added.`);
    console.log('  Legitimate when deleting an obsolete module. Never legitimate silently.');
  }

  const blocking = hits.filter((h) => h.severity === 'block');
  const warning = hits.filter((h) => h.severity === 'warn');

  for (const h of [...blocking, ...warning]) {
    console.log(`\n[${h.severity.toUpperCase()}] ${h.id}  ${h.file}`);
    console.log(`  ${h.why}`);
    console.log(`  ${h.line.trim()}`);
  }

  if (blocking.length === 0 && warning.length === 0 && delta.net >= 0) {
    console.log('\nno weakening patterns found.');
  }
  process.exit(blocking.length > 0 || delta.net < 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) run(process.argv[2] || 'HEAD');
