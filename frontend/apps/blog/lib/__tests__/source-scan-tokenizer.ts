/**
 * SHARED TOKENIZER for the hand-rolled source-scanning guards
 * (`server-cache-time-guard.test.ts`, `withttlcache-name-guard.test.ts`).
 * Extracted 2026-09-06 so the fix below lives in exactly one place instead
 * of two copies drifting apart.
 *
 * `maskNonCode` replaces every character that is part of a `//` line
 * comment, a `/* *\/` block comment, a `'...'` / `"..."` / `` `...` ``
 * string/template body, or a `/regex/flags` literal with a space, leaving
 * every newline and every real-code character exactly where it was — so
 * line numbers and column positions of any surviving match are unaffected.
 * Character-by-character and quote-aware so it cannot misread its own
 * source the way an earlier `.indexOf('/*')`-based masker once did (a
 * STRING LITERAL containing the two characters `/` `*` made that version
 * treat itself as one giant unterminated block comment).
 *
 * ★★★ REGEX-LITERAL AWARE (2026-09-06, found while building
 * `withttlcache-name-guard.test.ts`, then ported back here so
 * `server-cache-time-guard.test.ts` — which was scanning the same tree with
 * an earlier copy of this function that had no regex handling at all — gets
 * the identical fix instead of carrying the identical gap). Without this, a
 * regex literal containing a QUOTE character corrupts masking for the REST
 * OF THE FILE: `lib/feed/feed-prefetch.ts`'s own `BODY_IMAGE_PATTERNS` array
 * holds `/<img\s+[^>]*src="[^"]+"[^>]*>/i` — an ODD number of `"` inside one
 * regex literal — which, unmasked, flips a quote-only masker into
 * `double`-string mode and keeps it there (string/template modes do not
 * reset at a newline, on purpose, for real multi-line template literals)
 * until some UNRELATED `"` elsewhere in the file happens to close it,
 * blanking every real match after it to nothing. That is a silent
 * UNDERCOUNT, not a crash — the exact failure mode this file's own test
 * (`source-scan-tokenizer.test.ts`) and each guard's regression check exist
 * to catch.
 *
 * Regex-vs-divide is genuinely ambiguous in a hand-rolled tokenizer (`a / b`
 * vs `/regex/`). A `/` is treated as a regex literal start unless the last
 * significant character was one that could end a VALUE (a letter, digit,
 * `_`, `$`, `)`, `]`, or `` ` ``) — but a trailing letter alone is itself
 * ambiguous, because the last character of an identifier (`total / 2`) and
 * the last character of a KEYWORD (`return /foo/`) look identical to a
 * one-character lookbehind. ★ (2026-09-06) So when the last character is a
 * letter/digit/`_`/`$`, the tokenizer also tracks the contiguous identifier
 * run that produced it (`lastWord`, reset to empty at every string/comment/
 * regex mode-entry point so it can never carry a stale prefix across one of
 * those) and checks it against the keywords that can legally precede a
 * regex literal: `return`, `typeof`, `case`, `in`, `of`, `instanceof`,
 * `new`, `delete`, `void`, `do`, `else`, `yield`, `await`, `throw`. A match
 * means the `/` starts a regex even though the preceding character is a
 * letter (`return /a"b/;`); anything else ending in a letter — including a
 * lookalike identifier that merely ENDS in one of those words, e.g.
 * `preturn / 2` — is still division, exactly as before. The shape that
 * actually broke `feed-prefetch.ts` — a regex following `[`, `,`, `(`, `=`,
 * or the start of a line, none of which end a value — was already caught
 * before this keyword check existed and still is. Whatever is inside a
 * detected regex is blanked exactly like a string, so a `(`, `)`, `[`, `]`,
 * `{`, `}` or quote character INSIDE a regex literal can never be mistaken
 * for real code punctuation.
 */

type Mode = 'normal' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' | 'regexClass';

// Keywords after which a `/` is a regex literal, not division, even though
// each one ends in a letter (see the doc comment above). `in` and `of` are
// included for `for (x in /re/.exec(y))`-style and `for...of` guard shapes;
// both are also valid standalone operators (`"k" in obj`) where the same
// ambiguity applies.
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete',
  'void', 'do', 'else', 'yield', 'await', 'throw',
]);

export function maskNonCode(content: string): string {
  const n = content.length;
  const out: string[] = new Array(n);
  let mode: Mode = 'normal';
  let lastSignificant = '';
  let lastWord = ''; // contiguous identifier run behind lastSignificant, for the keyword check below
  let i = 0;
  while (i < n) {
    const c = content[i];

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (c === '\n') {
        out[i] = '\n';
        i++;
        continue;
      }
      const quoteChar = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (c === '\\') {
        out[i] = ' ';
        const nxt = i + 1 < n ? content[i + 1] : '';
        if (nxt === '\n') {
          i += 1; // leave the newline itself alone; loop handles it next pass
          continue;
        }
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === quoteChar) {
        out[i] = ' ';
        mode = 'normal';
        lastSignificant = quoteChar === '`' ? '`' : ')'; // a string behaves like a value for regex-vs-divide purposes
        i++;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    if (mode === 'regex' || mode === 'regexClass') {
      if (c === '\n') {
        // A real regex literal cannot span a newline unescaped; bail out to
        // normal mode rather than risk staying stuck (safer than the bug
        // this function exists to prevent).
        out[i] = '\n';
        mode = 'normal';
        i++;
        continue;
      }
      if (c === '\\') {
        out[i] = ' ';
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (mode === 'regex' && c === '[') {
        out[i] = ' ';
        mode = 'regexClass'; // `/` inside a character class does not end the regex
        i++;
        continue;
      }
      if (mode === 'regexClass' && c === ']') {
        out[i] = ' ';
        mode = 'regex';
        i++;
        continue;
      }
      if (mode === 'regex' && c === '/') {
        out[i] = ' ';
        mode = 'normal';
        // Consume trailing flag letters (g, i, m, s, u, y, d) as part of the
        // same blanked token.
        i++;
        while (i < n && /[a-z]/i.test(content[i])) {
          out[i] = ' ';
          i++;
        }
        lastSignificant = ')'; // a regex literal behaves like a value afterwards
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') {
        out[i] = '\n';
        mode = 'normal';
        i++;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    if (mode === 'block') {
      if (c === '\n') {
        out[i] = '\n';
        i++;
        continue;
      }
      const nxt = i + 1 < n ? content[i + 1] : '';
      if (c === '*' && nxt === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        mode = 'normal';
        i += 2;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    // mode === 'normal'
    if (c === '\n') {
      out[i] = '\n';
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      out[i] = c;
      i++;
      continue; // whitespace never counts as "the last significant character"
    }
    const nxt = i + 1 < n ? content[i + 1] : '';
    if (c === '/' && nxt === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      mode = 'line';
      lastWord = '';
      i += 2;
      continue;
    }
    if (c === '/' && nxt === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      mode = 'block';
      lastWord = '';
      i += 2;
      continue;
    }
    if (c === '/') {
      // Regex-vs-divide: see this file's own doc comment above. A trailing
      // letter/digit/`_`/`$` is ambiguous on its own (identifier vs.
      // keyword), so it defers to lastWord; `)`, `]` and `` ` `` are never
      // ambiguous (a paren/index/template result is always a value).
      const trailingIdentChar = /[A-Za-z0-9_$]/.test(lastSignificant);
      const isValueBefore = trailingIdentChar
        ? !REGEX_PRECEDING_KEYWORDS.has(lastWord)
        : /[)\]`]/.test(lastSignificant);
      if (!isValueBefore) {
        out[i] = ' ';
        mode = 'regex';
        lastWord = '';
        i++;
        continue;
      }
      // Falls through to the default "kept as code" branch below (division).
    }
    if (c === "'") {
      out[i] = ' ';
      mode = 'single';
      lastWord = '';
      i++;
      continue;
    }
    if (c === '"') {
      out[i] = ' ';
      mode = 'double';
      lastWord = '';
      i++;
      continue;
    }
    if (c === '`') {
      out[i] = ' ';
      mode = 'template';
      lastWord = '';
      i++;
      continue;
    }
    out[i] = c;
    lastSignificant = c;
    lastWord = /[A-Za-z0-9_$]/.test(c) ? lastWord + c : '';
    i++;
  }
  return out.join('');
}
