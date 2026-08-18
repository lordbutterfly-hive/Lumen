/**
 * ════ THE BLANKET PER-PAGE CHECKS ════
 *
 * Everything in this file runs on EVERY swept page without anyone writing a per-page
 * test. That is the whole point: a hand-written test only covers the page somebody
 * remembered, and the evidence on agent-written frontends is that the page they
 * remember is the one they just edited.
 *
 * ★ EVERY CHECK HERE MUST BE ABLE TO FAIL FOR "I FOUND NOTHING TO LOOK AT".
 * A selector that matches zero elements, a page that rendered nothing, a fixture that
 * loaded no data — all of those must be errors, not passes. Assert non-emptiness BEFORE
 * asserting content. This is the single most important property of the harness and the
 * one most easily lost in a refactor.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * CONSOLE + PAGE ERRORS
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Console noise that is real but not ours, and would otherwise train people to ignore
 * the check. Keep this list SHORT and justified — every entry is a blind spot.
 */
const CONSOLE_ALLOW = [
  /Download the React DevTools/i,
  /\[banned-authors\]/i, // the app's own deliberate startup warning
  /Failed to load resource.*favicon/i
];

/**
 * ★★ HYDRATION MISMATCHES ARE NEVER ALLOWLISTED. React silently reconciles after one,
 * so the final DOM looks correct and a screenshot proves nothing — the console line is
 * the ONLY evidence. In production builds the message is minified to a numeric code,
 * so both the readable and the minified forms are matched.
 */
export const HYDRATION_SIGNATURES =
  /Hydration failed|did not match|Text content does not match|Minified React error #(418|421|422|423|425)/;

export function attachConsoleCapture(page) {
  const errors = [];
  const warnings = [];
  const hydration = [];

  page.on('console', (msg) => {
    const text = msg.text();
    if (HYDRATION_SIGNATURES.test(text)) hydration.push(text);
    if (CONSOLE_ALLOW.some((re) => re.test(text))) return;
    if (msg.type() === 'error') errors.push(text);
    else if (msg.type() === 'warning') warnings.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  return { errors, warnings, hydration };
}

/* ────────────────────────────────────────────────────────────────────────────
 * NETWORK
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Requests we do not own and cannot fix. Same rule as the console allowlist: short,
 * and each entry is an accepted blind spot rather than a convenience.
 */
const NETWORK_ALLOW = [
  /\/favicon\./i,
  /googletagmanager|google-analytics|sentry\.io/i,
  // ★ THIRD-PARTY WIDGETS WE DO NOT CONTROL AND CANNOT FIX. Google's GSI button 403s in
  // a headless context because the origin is not an authorised JS origin — that is the
  // sign-in widget refusing an unregistered localhost, not a defect in this app. It fired
  // on 8 of 55 pages on the first clean run and would have buried the real findings.
  /accounts\.google\.com/i,
  // Opaque Response Blocking on a cross-origin image CDN: a browser security behaviour in
  // this fetch context, not a broken image. The image itself is asserted separately by
  // `findBrokenImages`, which checks whether it actually rendered.
  /images\.hive\.blog/i
];

export function attachNetworkCapture(page) {
  const failed = [];
  const badStatus = [];

  page.on('response', (res) => {
    const url = res.url();
    if (NETWORK_ALLOW.some((re) => re.test(url))) return;
    if (res.status() >= 400) badStatus.push(`${res.status()} ${url}`);
  });
  // ★ A 404 IS A RESPONSE, NOT A `requestfailed`. That event fires for DNS/timeout/abort
  // only — wiring just one of the two silently misses half the failures.
  //
  // ★★ `net::ERR_ABORTED` IS NOT A FAILURE, AND FILTERING IT IS THE DIFFERENCE BETWEEN A
  // USABLE CHECK AND NOISE (found on the harness's first real run, 2026-08-18: 16 of 55
  // pages "failed" on an aborted `/api/trending-tags`). React unmounts a component and
  // its in-flight fetch is cancelled — that is correct behaviour, and it happens on
  // essentially every page that renders a widget which resolves after a route change.
  // Reporting it would have trained everyone to ignore the whole network check within a
  // day.
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (NETWORK_ALLOW.some((re) => re.test(url))) return;
    const err = req.failure()?.errorText ?? 'failed';
    if (err.includes('ERR_ABORTED')) return;
    failed.push(`${err} ${url}`);
  });

  return { failed, badStatus };
}

/* ────────────────────────────────────────────────────────────────────────────
 * IN-PAGE CHECKS — one evaluate, so a page is only walked once
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Runs inside the browser. Returns a findings object; the spec decides what is fatal.
 *
 * ★ IT RETURNS `elementsInspected` SO AN EMPTY SWEEP CANNOT PASS. If a page renders
 * nothing, this comes back 0 and the caller FAILS the page rather than recording a
 * clean result for a blank screen.
 */
export function inspectPage(i18nNamespaces = []) {
  const out = {
    elementsInspected: 0,
    bodyTextLength: 0,
    overflow: null,
    overflowCulprits: [],
    zeroSizeInteractive: [],
    coveredInteractive: [],
    underStickyOverlay: [],
    phantomInteractive: [],
    truncated: [],
    badText: [],
    meta: {},
    headings: []
  };

  const all = Array.from(document.querySelectorAll('body *'));
  out.elementsInspected = all.length;
  out.bodyTextLength = (document.body?.innerText ?? '').trim().length;

  // ── horizontal overflow ─────────────────────────────────────────────────
  const de = document.documentElement;
  // 1px tolerance: subpixel rounding is the top false-positive source.
  out.overflow = de.scrollWidth > de.clientWidth + 1;
  if (out.overflow) {
    const vw = de.clientWidth;
    out.overflowCulprits = all
      .filter((el) => el.getBoundingClientRect().right > vw + 1)
      .slice(0, 10)
      .map((el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : ''}`);
  }

  // ── interactive elements: visible, sized, and actually on top ───────────
  const interactive = Array.from(
    document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=menuitem]'
    )
  );

  const isDisplayed = (el) => {
    // jest-dom's rule: a visible child inside a hidden parent is still hidden, so the
    // ancestor chain has to be walked. Playwright's own "visible" check treats
    // opacity:0 as VISIBLE, which is why this is separate from actionability.
    let node = el;
    while (node) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      node = node.parentElement;
    }
    return true;
  };

  /**
   * ★★★ THE GAP THIS CLOSES (D5, 2026-08-18).
   *
   * `isDisplayed` returns false for `opacity: 0` and every caller then `continue`s —
   * "deliberately hidden is not a defect". That is true of `display:none` and
   * `visibility:hidden`, which are how you MEAN to hide something. It is NOT true of
   * `opacity: 0`, which is how a fade-in STARTS.
   *
   * So a broken entrance animation — a stuck `lm-enter`, a transition whose end event
   * never fired, a class that was supposed to be removed on mount — leaves a real,
   * correctly-sized, fully-clickable button that renders as nothing. It passed every
   * check this harness has: not zero-size, not covered, no console error, no failed
   * request, and skipped by the visibility filter as if someone had hidden it on purpose.
   * An invisible working button is worse than a broken one, because nobody reports it.
   *
   * ★ WHY THIS IS NOT A FLOOD OF FALSE POSITIVES. Every legitimate reason to be at
   * opacity 0 is excluded explicitly:
   *   - a running or pending animation/transition — the element is MID-fade, which is
   *     the normal state this app is in for ~200ms after every route change. This is the
   *     single most important exclusion and it is why `getAnimations()` is consulted
   *     rather than just the computed style.
   *   - `aria-hidden` / `inert` / `[hidden]` — an author saying "not for anyone".
   *   - a closed `<details>`, a `dialog` without `open`, a popover that is not showing.
   *   - zero-size elements, which `zeroSizeInteractive` already reports; reporting them
   *     twice would just make both lists less trustworthy.
   *
   * What is left is: an element that takes up space, accepts clicks, nobody marked
   * hidden, and nothing is animating. There is no benign explanation for that.
   */
  const hasLiveAnimation = (el) => {
    try {
      // `subtree: true` matters — the opacity is very often animated on an ANCESTOR
      // (a staggered container), not on the button itself.
      return el.getAnimations({ subtree: true }).some((a) => a.playState === 'running' || a.playState === 'pending');
    } catch {
      // No getAnimations support: assume something might be animating rather than
      // report a finding we cannot stand behind.
      return true;
    }
  };

  const deliberatelyHidden = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.hasAttribute?.('hidden') || node.hasAttribute?.('inert')) return true;
      if (node.getAttribute?.('aria-hidden') === 'true') return true;
      const tag = node.tagName?.toLowerCase();
      if (tag === 'details' && !node.hasAttribute('open')) return true;
      if (tag === 'dialog' && !node.hasAttribute('open')) return true;
      if (node.hasAttribute?.('popover') && !node.matches?.(':popover-open')) return true;
      node = node.parentElement;
    }
    return false;
  };

  /** True when the element is invisible ONLY because something is at opacity 0. */
  const fadedToNothing = (el) => {
    let node = el;
    while (node) {
      const cs = getComputedStyle(node);
      // A genuinely hidden ancestor means this is the ordinary hidden case, not a phantom.
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (cs.opacity === '0') return true;
      node = node.parentElement;
    }
    return false;
  };

  for (const el of interactive) {
    if (!isDisplayed(el)) {
      // D5: separate "hidden on purpose" from "stuck mid-fade". See fadedToNothing above.
      const r0 = el.getBoundingClientRect();
      if (
        fadedToNothing(el) &&
        r0.width > 0 &&
        r0.height > 0 &&
        !deliberatelyHidden(el) &&
        !hasLiveAnimation(el) &&
        getComputedStyle(el).pointerEvents !== 'none'
      ) {
        out.phantomInteractive.push(
          `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}[${(el.textContent || '').trim().slice(0, 24)}] ${Math.round(r0.width)}x${Math.round(r0.height)}`
        );
      }
      continue;
    }
    const r = el.getBoundingClientRect();
    const label = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}[${(el.textContent || '').trim().slice(0, 24)}]`;

    if (r.width === 0 || r.height === 0) {
      out.zeroSizeInteractive.push(label);
      continue;
    }
    // Only judge elements actually inside the viewport — below-the-fold content is
    // legitimately not hit-testable and flagging it would drown the signal.
    const inViewport = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (!inViewport) continue;

    // ★ THE HIT-TEST. This is the same question Playwright asks before every click:
    // is this element the thing the pointer would actually reach at its own centre?
    //
    // ★★ AN OVERLAY WITH `pointer-events: none` DOES NOT COVER ANYTHING. It is painted
    // on top but the click passes straight through to the element beneath, which is the
    // whole reason that property exists. Without this filter the check fired on 10 of 55
    // pages against decorative gradients and hover layers — all of them clickable in
    // practice. Found by triaging the harness's own first run rather than by reasoning.
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && !(top === el || el.contains(top) || top.contains(el))) {
      if (getComputedStyle(top).pointerEvents === 'none') continue;

      // ★★★ A STICKY/FIXED OVERLAY IS A DIFFERENT CLAIM FROM A COVERED CONTROL, AND
      // CONFLATING THEM WAS THE HARNESS'S OWN NOISE (found 2026-08-18 by an agent that
      // root-caused it rather than reporting it).
      //
      // The sweep scrolls to the bottom of the page before measuring. Anything that then
      // lands in the top ~90px sits under `app-header.tsx`'s `sticky top-0 z-40` bar, so
      // `elementFromPoint` correctly answers "the header" — and 9 of 55 pages were being
      // reported as having covered controls that a user can simply scroll clear.
      //
      // It is NOT nothing, though: a control that can never be scrolled out from under a
      // sticky bar (an anchor target, a short page) is genuinely unreachable. So it is
      // recorded separately rather than dropped, at a lower tier, with the covering
      // element's position named.
      let node = top;
      let stickyAncestor = null;
      while (node && node !== document.body) {
        const pos = getComputedStyle(node).position;
        if (pos === 'sticky' || pos === 'fixed') { stickyAncestor = pos; break; }
        node = node.parentElement;
      }
      if (stickyAncestor) out.underStickyOverlay.push(`${label} (under ${stickyAncestor})`);
      else out.coveredInteractive.push(label);
    }
  }

  // ── text clipped by its own container ───────────────────────────────────
  // Candidates only. `text-overflow: ellipsis` is usually deliberate, so this is a
  // diff-over-time signal (did a copy change start clipping something?), not a gate.
  out.truncated = all
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && (el.textContent || '').trim().length > 0)
    .slice(0, 20)
    .map((el) => (el.textContent || '').trim().slice(0, 40));

  // ── text that should never reach a reader ──────────────────────────────
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  /**
   * ★★ A REAL NAMESPACE IS NOT ENOUGH EITHER (D6, 2026-08-18).
   *
   * Requiring the first segment to be a genuine i18n namespace already killed the
   * `run.vince.run` false positive (a Hive community name). It does not kill
   * `wallet.exe.download`: `wallet` IS a namespace in this app's catalogue, so a filename
   * or a hostname that happens to start with a namespace word still reports as an
   * unresolved translation key.
   *
   * A key from this catalogue never ends in a file extension or a TLD, so any string whose
   * LAST segment is one is a filename/domain and not a key. Cheap, and it closes the whole
   * shape rather than the one example that was observed.
   */
  const NOT_A_KEY_TAIL = new Set([
    'com', 'net', 'org', 'io', 'co', 'app', 'dev', 'exe', 'zip', 'tar', 'gz', 'js', 'ts',
    'tsx', 'jsx', 'json', 'css', 'html', 'md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
    'pdf', 'mp4', 'webm', 'sh', 'py', 'go', 'rs', 'lock', 'log', 'yml', 'yaml', 'toml'
  ]);

  const looksLikeI18nKey = (text, namespaces) => {
    if (!/^[a-z0-9_]+(\.[a-z0-9_]+){1,}$/.test(text)) return false;
    const parts = text.split('.');
    if (!namespaces.includes(parts[0])) return false;
    if (NOT_A_KEY_TAIL.has(parts[parts.length - 1])) return false;
    return true;
  };

  const BAD = [
    { re: /\[object Object\]/, why: 'object rendered as string' },
    { re: /\bInvalid Date\b/, why: 'unparsed date' },
    { re: /\bundefined\b/, why: 'undefined leaked into copy' },
    { re: /\bNaN\b/, why: 'NaN leaked into copy' },
    // ★★ A DOTTED TOKEN IS NOT ENOUGH — IT MUST START WITH A REAL i18n NAMESPACE.
    // The first version matched any lowercase dotted token with 2+ dots, and on the
    // first real run it flagged `run.vince.run`, which is a Hive COMMUNITY NAME coming
    // back from the live API. Domains, community handles, version strings and file names
    // all have that shape. Checking the first segment against the actual top-level keys
    // in `locales/en/common_blog.json` makes a hit mean something: this string looks like
    // a key from THIS app's catalogue that failed to resolve.
    { re: null, namespaced: true, why: 'raw i18n key' }
  ];
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent) continue;
    // Code samples legitimately contain `undefined`/`NaN`; prose about JS does too.
    if (parent.closest('pre, code, script, style')) continue;
    const text = (node.textContent || '').trim();
    if (!text) continue;
    /**
     * ★ NO `break` (D6, 2026-08-18). This loop used to stop at the first matching rule per
     * node, so a string carrying BOTH `undefined` and `NaN` reported one of them and the
     * other was invisible until the first was fixed - the classic way a triage list keeps
     * regrowing after every "fix". Every rule that matches now reports.
     */
    for (const rule of BAD) {
      const hit = rule.namespaced ? looksLikeI18nKey(text, i18nNamespaces) : rule.re.test(text);
      if (hit) {
        out.badText.push({ why: rule.why, text: text.slice(0, 80), tag: parent.tagName.toLowerCase() });
      }
    }
  }

  // ── meta / SEO / document basics ───────────────────────────────────────
  const attr = (sel, name) => document.querySelector(sel)?.getAttribute(name) ?? null;
  out.meta = {
    title: document.title || null,
    description: attr('meta[name="description"]', 'content'),
    canonical: attr('link[rel="canonical"]', 'href'),
    lang: document.documentElement.getAttribute('lang'),
    ogTitle: attr('meta[property="og:title"]', 'content'),
    ogImage: attr('meta[property="og:image"]', 'content'),
    h1Count: document.querySelectorAll('h1').length
  };

  out.headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) =>
    Number(h.tagName.slice(1))
  );

  return out;
}

/**
 * Heading order, checked outside the page so it is unit-testable.
 *
 * A jump from h2 to h4 is a real structural defect for screen-reader users and is
 * invisible in a screenshot. Missing h1 entirely is reported separately by `meta`.
 */
export function findHeadingJumps(levels) {
  const jumps = [];
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) jumps.push(`h${levels[i - 1]} -> h${levels[i]}`);
  }
  return jumps;
}

/**
 * Images that failed to load.
 *
 * Separate from `inspectPage` because it must run AFTER a scroll pass — `next/image`
 * lazy-loads, so asserting on load state before scrolling reports false failures for
 * images that were simply never asked for.
 */
export function findBrokenImages() {
  return Array.from(document.querySelectorAll('img'))
    .filter((img) => img.loading !== 'lazy' || img.complete)
    .filter((img) => img.complete && img.naturalWidth === 0)
    .map((img) => img.currentSrc || img.src)
    .filter(Boolean);
}
