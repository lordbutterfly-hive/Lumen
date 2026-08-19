/**
 * DID EVERY §4 EDIT SHIP IN THE BUILT ARTIFACT?
 *
 * `qa-italic-sites.mjs` drives the browser, which is the stronger evidence — but
 * an empty-state string does not render until its state is empty, and several of
 * these cannot be forced on a live account that has posts, follows and
 * notifications. For those, this checks the next best thing: that the className
 * carrying `italic` is present in the chunks the server actually serves, and that
 * the pre-edit string is GONE. That is weaker than seeing it on screen and is
 * reported as such — it proves the edit shipped, not that the state renders.
 */
import fs from 'fs';
import path from 'path';

const DIST = '/home/clauderfly/hive-blog-rebuild/apps/blog/.next-qa';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!/^(cache|types)$/.test(e.name)) walk(p); }
    else if (/\.(js|css)$/.test(e.name)) files.push(p);
  }
})(DIST);

const blobs = files.map((f) => fs.readFileSync(f, 'utf8'));
const has = (s) => blobs.some((b) => b.includes(s));

const CASES = [
  // ★ THE OLD STRING LEGITIMATELY SURVIVES HERE. `topic-shell.tsx:207` uses the
  // same class for its LOAD ERROR, which §4 keeps roman, so "both present" is the
  // correct result and not a half-applied edit.
  ['empty feed "No posts yet."',      'py-12 text-center font-sans text-sm italic text-muted-foreground', null],
  // same: notifications-menu.tsx:282 is the ERROR state and stays roman
  ['notifications empty',             'px-4 py-10 text-center text-sm italic text-ink-10',                null],
  ['following/followers empty',       'font-sans text-caption font-normal italic text-[#6b7280]',         'font-sans text-caption font-normal text-[#6b7280]'],
  ['blocked list empty',              'text-[14px] leading-[22px] italic text-ink-10',                    null],
  ['no Meritum / no asks',            'py-8 text-center font-serif text-sm italic text-ink-14',           'py-8 text-center font-serif text-sm text-ink-14'],
  ['studio: no requests',             'py-6 text-center font-serif text-sm italic text-ink-14',           'py-6 text-center font-serif text-sm text-ink-14'],
  ['studio: no services',             'px-4 py-5 text-center text-caption italic text-ink-14',            null],
  ['price chart fallback',            'items-center justify-center text-caption italic text-ink-14',      null],
  ['token market empty body',         'mt-1 text-caption italic text-ink-14',                             'mt-1 text-caption text-ink-14'],
  // same: search-results.tsx uses this class twice for copy that is not an empty state
  ['"Be the first to reply." body',   'font-sans text-caption italic text-muted-foreground',              null],
  ['feed status strip',               'font-sans text-caption italic text-[#9a7b2e]',                     'font-sans text-caption text-[#9a7b2e]'],
  ['404 body',                        'text-[15px] leading-[26px] italic text-ink-10',                    'text-[15px] leading-[26px] text-ink-10'],
  // ★ SEARCHED IN ITS COMPILED FORM. The source is a template literal
  // (`${className} italic`), which the bundler turns into a concat call — looking
  // for the source text reported a false MISSING on an edit that had shipped.
  ['end-of-list line (shared footer)', 'concat(f," italic")',                                             null]
];

console.log(`scanned ${files.length} built files under .next-qa\n`);
console.log(`${'site'.padEnd(34)} shipped  old-string-gone`);
let ok = 0, bad = 0;
for (const [label, want, stale] of CASES) {
  const present = has(want);
  const staleGone = stale === null ? null : !has(stale);
  const good = present && staleGone !== false;
  good ? ok++ : bad++;
  console.log(`${label.padEnd(34)} ${present ? 'yes    ' : 'NO     '}  ${staleGone === null ? 'n/a' : staleGone ? 'yes' : 'NO — both versions present'}`);
}
console.log(`\n${ok}/${CASES.length} edits present in the served bundle${bad ? `, ${bad} MISSING` : ''}`);

// the one REMOVAL
const removedStale = has('font-sans text-caption italic text-ink-14') ;
console.log(`\nremoval — proposal-support-footer status text:`);
console.log(`  old italic class string still in bundle: ${removedStale ? 'YES (check it is a different element)' : 'no'}`);
process.exit(bad ? 1 : 0);
