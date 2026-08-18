/**
 * ════ INVALID AT COMPUTED-VALUE TIME (IACVT) ════
 *
 * ★★★ THIS DETECTOR EXISTS BECAUSE THIS EXACT BUG SHIPPED IN THIS REPO (2026-08-18).
 *
 * `ManabarRing` drew a progress ring by painting a conic gradient across a disc and
 * covering the middle with a smaller circle carrying:
 *
 *     backgroundColor: 'var(--background)'
 *
 * `--background` holds `0 0% 100%` — a raw HSL TRIPLET, not a colour. Every other
 * consumer in the codebase wraps it (`hsl(var(--background))`), and that file's own
 * border did too (`hsl(var(--border))`). This one did not. The result:
 *
 *   - the CSS PARSES FINE, because `var(...)` is syntactically valid for any property;
 *   - the substituted value `0 0% 100%` fails `<color>`'s grammar at COMPUTED-VALUE
 *     time, so the declaration becomes "invalid at computed-value time" (IACVT);
 *   - per spec the property then resolves to its inherited value, or its initial value
 *     if not inherited — for `background-color` that is `transparent`;
 *   - there is NO console warning, NO devtools strikethrough, and NO error anywhere.
 *
 * The visible consequence was a filled pie instead of a ring, burying the rank emblem,
 * the daily card's count, and the user's own avatar under three stacked discs.
 *
 * ════ WHY NOTHING ELSE CATCHES IT ════
 *
 * | tool | why it misses this |
 * |---|---|
 * | stylelint `declaration-property-value-no-unknown` | validates the literal source text; `var(--x)` is always legal syntax |
 * | CDP `CSS.getMatchedStylesForNode` → `parsedOk` | parsing SUCCEEDS; the failure is downstream at substitution |
 * | TypeScript | it is a string in a style object |
 * | screenshot diff | only if you had a baseline from before the bug, and only if a human reads the diff |
 * | axe-core contrast | checks TEXT contrast; this was a background behind a glyph |
 *
 * ════ HOW THIS DETECTOR WORKS, AND WHY IT IS TWO-PART ════
 *
 * ★★ THE RUNTIME PROBE ALONE FALSE-POSITIVES ON CORRECT CODE. Verified empirically
 * before writing this file (Chrome 151, 2026-08-18):
 *
 *   background-color: var(--background)        raw `0 0% 100%`  -> computed rgba(0,0,0,0)   probe REJECTS  <- bug
 *   color:            var(--border)            raw `0, 0%, 93%` -> computed rgb(0,0,0)      probe REJECTS  <- bug
 *   background-color: hsl(var(--background))   raw `0 0% 100%`  -> computed rgb(255,255,255) probe REJECTS  <- CORRECT CODE
 *   background-color: var(--good)              raw `#ff0000`    -> computed rgb(255,0,0)     probe ACCEPTS
 *
 * Row three is the whole point: the probe cannot tell a bare `var()` from one wrapped
 * in `hsl()`, because it only ever sees the variable's raw value. A probe-only detector
 * would have flagged every correct `hsl(var(--x))` in the codebase and been switched off
 * within a day.
 *
 * So detection is:
 *   PART 1 (static)  — scan SOURCE for a colour-ish property consuming a custom property
 *                      BARE, with no wrapping colour function. This produces candidates.
 *   PART 2 (runtime) — for each candidate, ask the browser's own CSS engine whether the
 *                      variable's actual value is acceptable for that property, by
 *                      round-tripping it through `setProperty` on a detached element
 *                      (`setProperty` silently no-ops on an invalid value, so a failed
 *                      round-trip is a hard signal, not a heuristic).
 *
 * Only a candidate that fails BOTH is reported. That combination has, by construction,
 * a false-positive rate of zero on the four cases above.
 */

/** Properties whose value must be a `<color>`. A bare `var()` here is the risk surface. */
export const COLOUR_PROPERTIES = [
  'color',
  'background-color',
  'background',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'fill',
  'stroke',
  'caret-color',
  'text-decoration-color',
  'column-rule-color',
  'accent-color'
];

/**
 * Colour functions that make a bare-looking `var()` legitimate.
 *
 * If the declaration is `hsl(var(--x))` the variable is an INPUT to a function, not the
 * whole value, and a triplet is exactly what it should hold. Only an UNWRAPPED `var()`
 * is a candidate.
 */
const WRAPPERS = ['hsl', 'hsla', 'rgb', 'rgba', 'lab', 'lch', 'oklab', 'oklch', 'hwb', 'color', 'color-mix', 'light-dark'];

/** `backgroundColor` -> `background-color`, for JS style objects. */
function kebab(prop) {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * PART 1 — the static scan.
 *
 * ★★ IT MUST SCAN JS/TSX STYLE OBJECTS, NOT JUST CSS — AND THE FIRST VERSION OF THIS
 * FUNCTION DID NOT, WHICH MEANT IT MISSED THE VERY BUG IT WAS WRITTEN FOR (caught by
 * this file's own verification run, 2026-08-18).
 *
 * The real defect was in a React inline style:
 *
 *     style={{ backgroundColor: 'var(--background)' }}
 *
 * camelCase property, quoted value, comma-separated — none of which a CSS-shaped regex
 * (`prop: value;`) matches. A detector that only reads `.css` files would have reported
 * this codebase clean while the bug was live on three surfaces. Both syntaxes are
 * scanned now, and the JS form is the one that found the real bug.
 *
 * Deliberately conservative on nesting: it will not flag
 * `background: linear-gradient(var(--x), ...)` or `hsl(var(--x) / 0.5)`. Missing a rare
 * bug there is a far smaller failure than crying wolf on the hundreds of correct
 * `hsl(var(--token))` declarations this codebase legitimately contains.
 *
 * @param {string} source  CSS text, or JS/TSX source containing style objects
 * @returns {{property: string, variable: string, raw: string, syntax: 'css'|'js'}[]}
 */
export function findBareVarColourUses(rawSource, filePath = '') {
  // ★★ COMMENTS ARE STRIPPED FIRST, AND THAT IS NOT TIDINESS (caught 2026-08-18 on the
  // first real scan). This file's OWN doc comment quotes the bug it was written for —
  // `backgroundColor: 'var(--background)'` — so the scanner flagged `manabar-ring.tsx`,
  // a file whose bug had already been FIXED, purely because the fix's comment describes
  // what was wrong. A guard that fires on prose about a bug, rather than the bug, is a
  // guard people switch off. The same trap is documented in ladder.test.ts's `voiced`
  // call-site scan, which strips comments for exactly this reason.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments (CSS and JS)
    .replace(/^\s*\/\/.*$/gm, ' '); // whole-line JS comments

  const found = [];
  const cssProps = COLOUR_PROPERTIES.join('|');
  // camelCase equivalents, for JS style objects.
  const jsProps = COLOUR_PROPERTIES.map((p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase())).join('|');

  /**
   * ★★★ SCOPED TO THIS DECLARATION, NOT TO A FIXED CHARACTER WINDOW.
   *
   * The first version looked back a flat 24 characters for a wrapper function name.
   * That made the detector suppress THE EXACT BUG IT WAS WRITTEN FOR whenever a
   * correctly-wrapped sibling declaration happened to sit nearby:
   *
   *     .ring-back {
   *       border-color: hsl(var(--border));      <- the `hsl(` the window sees
   *       background-color: var(--background);   <- the real, unfixed bug
   *     }
   *
   * Zero hits. And that is not a contrived case — it is word for word the shape this
   * file's own header describes ("this file's own border did too... This one did not").
   * An adversarial review found it; the false negative persisted across normal
   * multi-line, indented and minified CSS.
   *
   * The lookback now starts at the boundary of the current declaration (`;` or `{`),
   * so a neighbouring declaration can never vouch for this one. Verified to produce
   * identical results on all 12 real candidates in this codebase — the fix costs
   * nothing and closes a landmine.
   */
  const notWrapped = (source, atIndex, varOffset) => {
    const declStart = Math.max(source.lastIndexOf(';', atIndex), source.lastIndexOf('{', atIndex), source.lastIndexOf(',', atIndex)) + 1;
    const before = source.slice(Math.max(declStart, 0), atIndex + varOffset);
    return !WRAPPERS.some((fn) => before.includes(`${fn}(`));
  };

  // ── CSS syntax: `background-color: var(--x);`
  const cssRe = new RegExp(
    `(?:^|[;{\\s])(${cssProps})\\s*:\\s*(var\\(\\s*(--[\\w-]+)[^;}]*\\))\\s*(?:!important)?\\s*(?=[;}]|$)`,
    'gim'
  );
  let m;
  while ((m = cssRe.exec(source)) !== null) {
    const [, property, raw, variable] = m;
    if (!notWrapped(source, m.index, m[0].indexOf('var('))) continue;
    found.push({ property: property.toLowerCase(), variable, raw, syntax: 'css' });
  }

  // ── JS/TSX style objects: `backgroundColor: 'var(--x)'` or `` `var(--x)` ``
  const jsRe = new RegExp(
    `\\b(${jsProps})\\s*:\\s*(['"\`])(\\s*var\\(\\s*(--[\\w-]+)[^)]*\\)\\s*)\\2`,
    'gm'
  );
  while ((m = jsRe.exec(source)) !== null) {
    const [, prop, , raw, variable] = m;
    if (!notWrapped(source, m.index, m[0].indexOf('var('))) continue;
    found.push({ property: kebab(prop), variable, raw: raw.trim(), syntax: 'js' });
  }

  /**
   * ════ SHORTHANDS (D7, 2026-08-18) ════
   *
   * ★★ THE TWO REGEXES ABOVE BOTH REQUIRE `var()` TO BE THE WHOLE VALUE. They anchor on
   * `: var(--x)` followed by `;` or `}`, so they see
   *
   *     background-color: var(--surface);        <- caught
   *
   * and are blind to
   *
   *     background: var(--surface) center / cover no-repeat;   <- missed
   *     border: 1px solid var(--line);                          <- missed
   *
   * The risk is identical. A shorthand parses as a whole: substitute a bare triplet like
   * `0 0% 93%` where a `<color>` component belongs and the ENTIRE declaration is invalid
   * at computed-value time - so the element loses its border AND its width AND its style,
   * not just its colour. Strictly worse than the case already covered, and silent in
   * exactly the same way.
   *
   * ★★★ REPORTED AT THE SHORTHAND ITSELF, NOT AT ITS COLOUR SLOT - AND THE FIRST VERSION
   * OF THIS GOT IT BACKWARDS. It mapped `background` to `background-color` on the theory
   * that the colour slot is the grammar to test. Run against this codebase that produced
   * FOUR candidates and ZERO real bugs: `background: var(--mt-reed)` where `--mt-reed` is
   * a `repeating-conic-gradient(...)`. A gradient is a perfectly legal `background` and
   * an illegal `background-color`, so the mapping INVENTED the failure it then reported.
   *
   * Probing the shorthand is both simpler and correct: a gradient passes `background`, and
   * a bare triplet like `0 0% 93%` still fails it. The property whose grammar must hold is
   * the one actually written in the stylesheet.
   *
   * ★ CSS FILES ONLY. The same scan over `.tsx` matched inside a Tailwind class string
   * (`shadow-[3px_3px_0px_var(--tw-shadow-color)]`) and reported it as an `outline`
   * declaration. Class strings are not CSS declarations; JS style objects are handled by
   * their own branch above, which knows it is reading JS.
   */
  const SHORTHAND_COLOUR_SLOT = {
    background: 'background',
    border: 'border',
    'border-top': 'border-top',
    'border-right': 'border-right',
    'border-bottom': 'border-bottom',
    'border-left': 'border-left',
    outline: 'outline',
    'text-decoration': 'text-decoration',
    'column-rule': 'column-rule'
  };
  const shorthandRe = new RegExp(
    `(?:^|[;{\\s])(${Object.keys(SHORTHAND_COLOUR_SLOT).join('|')})\\s*:\\s*([^;{}]*?var\\(\\s*--[\\w-]+[^;{}]*)(?=[;}]|$)`,
    'gim'
  );
  if (/\.css$/i.test(filePath)) while ((m = shorthandRe.exec(source)) !== null) {
    const shorthand = m[1].toLowerCase();
    const value = m[2];
    // Every var() in the value, each judged on its own wrapper.
    const varRe = /var\(\s*(--[\w-]+)[^)]*\)/g;
    let v;
    while ((v = varRe.exec(value)) !== null) {
      const absolute = m.index + m[0].indexOf(value) + v.index;
      if (!notWrapped(source, absolute, 0)) continue;
      found.push({
        property: SHORTHAND_COLOUR_SLOT[shorthand],
        variable: v[1],
        raw: v[0],
        syntax: 'css-shorthand',
        shorthand
      });
    }
  }

  // De-duplicate: the same property+variable pair reported once per syntax is noise.
  const seen = new Set();
  return found.filter((f) => {
    const k = `${f.property}|${f.variable}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * PART 2 — the runtime probe, run inside the page.
 *
 * ★ A REAL FUNCTION, NOT A STRING. The first version exported this as a string and
 * called `page.evaluate(PROBE_FN, candidates)` — but Playwright treats a string argument
 * as an EXPRESSION to evaluate, not a function to invoke, so it returned `undefined` and
 * the self-test blew up on `undefined.some`. Caught by running it; it would otherwise
 * have silently reported "no IACVT issues" on every page forever.
 *
 * ★ IT READS THE VARIABLE OFF EVERY SCOPE THAT DECLARES IT, not just `:root`. A custom
 * property can be redefined per component, so a token that is a valid colour globally
 * may be a bare triplet somewhere deeper — exactly the override hardest to spot by eye.
 */
export function probeInPage(candidates) {
  const probe = document.createElement('div');
  const accepts = (prop, value) => {
    probe.style.cssText = '';
    probe.style.setProperty(prop, value);
    return probe.style.getPropertyValue(prop) !== '';
  };

  const results = [];
  const seen = new Set();
  const scopes = [document.documentElement, document.body, ...document.querySelectorAll('[class],[style]')];

  for (const { property, variable } of candidates) {
    for (const el of scopes) {
      if (!el) continue;
      const raw = getComputedStyle(el).getPropertyValue(variable).trim();
      if (!raw) continue;
      const key = `${property}|${variable}|${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!accepts(property, raw)) {
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : '';
        results.push({
          property,
          variable,
          rawValue: raw,
          // What the browser actually painted, so the report shows the damage as well as
          // the diagnosis.
          computed: getComputedStyle(el).getPropertyValue(property),
          scope: el === document.documentElement ? ':root' : `${el.tagName.toLowerCase()}${cls}`
        });
      }
    }
  }
  return results;
}

/**
 * A self-test with a KNOWN-BAD and a KNOWN-GOOD case.
 *
 * ★ THE HARNESS MUST PROVE ITS OWN DETECTOR STILL WORKS. A detector that silently stops
 * detecting reports "no IACVT bugs" forever, which is indistinguishable from success —
 * the single most dangerous shape a check can take. This fixture is injected before the
 * real sweep; if the known-bad case is not caught, the run FAILS rather than reporting
 * a clean sweep.
 */
export const SELF_TEST_CSS = `
  :root { --harness-triplet-css: 0 0% 100%; --harness-triplet-js: 0 0% 100%; --harness-real: #ff0000; }
  .harness-known-bad  { background-color: var(--harness-triplet-css); }
  .harness-known-bad-js { background-color: var(--harness-triplet-js); }
  .harness-known-good { background-color: var(--harness-real); }
`;

/**
 * ★★★ DERIVED BY RUNNING THE SCANNER, NOT HARDCODED (fixed 2026-08-18, adversarial review).
 *
 * The first version was a hand-written 2-entry array, which meant the self-test exercised
 * only PART 2 (the runtime probe) — while BOTH historical bugs in this file lived in
 * PART 1 (the static scan): the regex that missed JS style objects, and the scanner that
 * flagged its own comment. A reviewer reconstructed the pre-fix scanner and confirmed the
 * self-test still reported "PASSED" with Part 1 completely broken.
 *
 * Now the fixture below contains both historical bug shapes plus a comment quoting one,
 * and the candidates are whatever `findBareVarColourUses` actually extracts from it. If
 * the scanner regresses in either direction, the self-test stops matching and the sweep
 * aborts instead of reporting a clean run.
 */
export const SELF_TEST_SOURCE = `
  /* A comment quoting the historical bug: backgroundColor: 'var(--harness-triplet)'.
     This must NOT be extracted — prose about a bug is not a bug. */
  .harness-known-bad { border-color: hsl(var(--harness-real)); background-color: var(--harness-triplet-css); }
  .harness-known-good { background-color: hsl(var(--harness-triplet-css)); }
  const style = { backgroundColor: 'var(--harness-triplet-js)' };
`;
// ★★ THE CSS BUG AND THE JS BUG USE DIFFERENT TOKENS ON PURPOSE. With one shared token
// the de-duplication in `findBareVarColourUses` collapsed both to a single candidate, so
// the JS-object branch could regress and the self-test would still see one candidate and
// pass — re-introducing the very blind spot this fixture was rewritten to close. Two
// tokens means two candidates, and losing either branch is now a hard failure.

export const SELF_TEST_CANDIDATES = findBareVarColourUses(SELF_TEST_SOURCE).map(({ property, variable }) => ({
  property,
  variable
}));

/**
 * Assert the detector is alive. Throws if the known-bad case is not flagged, or if the
 * known-good case IS flagged.
 */
export function assertSelfTest(results) {
  // ★ PART 1 MUST HAVE PRODUCED CANDIDATES AT ALL. An empty candidate list makes the
  // runtime probe trivially "clean" — the vacuous pass this harness exists to refuse.
  if (SELF_TEST_CANDIDATES.length === 0) {
    throw new Error(
      'IACVT self-test FAILED: the static scanner extracted ZERO candidates from a fixture ' +
        'containing two known bugs. Part 1 is broken; a clean sweep would be meaningless.'
    );
  }
  // ★ AND IT MUST NOT HAVE EXTRACTED THE COMMENT. Both directions, or the scanner can
  // regress into crying wolf and still "pass".
  if (SELF_TEST_CANDIDATES.length !== 2) {
    throw new Error(
      `IACVT self-test FAILED: the static scanner extracted ${SELF_TEST_CANDIDATES.length} candidates ` +
        'from a fixture with 2 real bugs — it is matching prose or wrapped declarations again.'
    );
  }
  const caughtCss = results.some((r) => r.variable === '--harness-triplet-css');
  const caughtJs = results.some((r) => r.variable === '--harness-triplet-js');
  const caughtBad = caughtCss && caughtJs;
  const falsePositive = results.some((r) => r.variable === '--harness-real');
  if (!caughtBad) {
    throw new Error(
      `IACVT self-test FAILED: css-branch caught=${caughtCss}, js-branch caught=${caughtJs} — a known-bad case was NOT detected. ` +
        'The detector is broken — a clean sweep from it would be meaningless. Fix the detector before trusting any result.'
    );
  }
  if (falsePositive) {
    throw new Error(
      'IACVT self-test FAILED: the known-GOOD `background-color: var(--harness-real)` was flagged. ' +
        'The detector cries wolf and will be switched off within a week. Fix it.'
    );
  }
}
