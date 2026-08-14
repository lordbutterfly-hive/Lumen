import { EditorView } from '@codemirror/view';
import { Extension, StateEffect, StateField } from '@codemirror/state';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';

/**
 * ★★★ THE COMPOSER USED TO DOUBLE EVERY LIST MARKER YOU TYPED (2026-08-13, audit §1.3).
 *
 * MEASURED on the shipped build at :3000 before this file existed — typed into
 * the real `/submit.html` editor, read back off `.cm-content`:
 *
 *   typed  "- one"   ⏎ "- two"   ⏎   ->  "- one\n- - two\n  - "
 *   typed  "* one"   ⏎ "* two"   ⏎   ->  "* one\n* * two\n  * "
 *   typed  "+ one"   ⏎ "+ two"   ⏎   ->  "+ one\n+ + two\n  + "
 *   typed  "1. one"  ⏎ "2. two"  ⏎   ->  "1. one\n2. 2. two\n   3. "
 *   typed  "- [ ] one" ⏎ "- [ ] two" ⏎ -> "- [ ] one\n- [ ] - [ ] two\n- [ ] "
 *   typed  "- one" ⏎ "  - sub" ⏎ "  - sub2" ⏎
 *                                    ->  "- one\n-   - sub\n    -   - sub2\n        - "
 *
 * THE MECHANISM. `@codemirror/lang-markdown`'s `insertNewlineContinueMarkup`
 * (bound to Enter by `markdownKeymap`, which `markdown()` installs at
 * `Prec.high`) is doing exactly what it promises: on Enter inside a list it
 * opens the next line already carrying the list's marker. Nothing then
 * reconciles that auto-inserted marker with a marker the author types
 * immediately after it, so both survive — `"- "` + `"- two"` = `"- - two"`,
 * which CommonMark reads as a NESTED list, so the next Enter continues the
 * nested level and the run ends on an ever-deeper orphan bullet. Every marker
 * style is affected because the continuation is marker-generic.
 *
 * This is not a hypothetical typing style: a marker is the first thing most
 * people type on a new list line, and it is what every paste-free "type the
 * markdown you want" flow produces. The author sees a bullet appear, types the
 * bullet they meant, and the document silently ends up with two.
 *
 * THE FIX, in one sentence: the auto-inserted marker is PROVISIONAL — if the
 * author types their own marker over it, theirs wins and the automatic one is
 * dropped; if they just type text, the automatic one stays and the list
 * continues exactly as it does today.
 *
 * ★ WHY STATE AND NOT A PATTERN MATCH. `"- - two"` is *legal* markdown (an
 * inline nested list), so collapsing on shape alone would make a deliberate
 * nested list impossible to type. The collapse therefore only ever fires
 * against a marker THIS module inserted and that the author has not touched:
 * `provisionalMarker` below holds that exact range and self-destructs the
 * moment the text under it changes, the cursor leaves its line, or anything
 * else edits the document. It can never remove a character the author typed.
 */

/** One markdown block marker: bullet, ordered, either with a task-list box, or a blockquote. */
const MARKER = String.raw`(?:[-*+](?:[ \t]+\[[ xX]\])?|\d+[.)](?:[ \t]+\[[ xX]\])?|>)`;

/** A line carrying nothing but indentation and one marker — i.e. a bullet nobody has written into yet. */
const MARKER_ONLY_RE = new RegExp(`^[ \\t]*${MARKER}[ \\t]*$`);

/** Exactly "indent + marker + one space" — the shape of a marker somebody has just finished typing. */
const TYPED_MARKER_RE = new RegExp(`^[ \\t]*${MARKER}[ \\t]$`);

type ProvisionalMarker = {
  from: number;
  to: number;
  text: string;
  /**
   * Indentation to keep if the author types a bare marker over this one.
   *
   * Empty for a marker Enter continued: that line's indentation was INHERITED
   * from the line above, nobody chose it, so typing `"- "` means a top-level
   * item and gets one. Set to the line's own indent for a marker Tab or
   * Shift-Tab produced: there the indentation IS what the author just asked
   * for, and silently undoing it on the next keystroke would be the surprise.
   */
  indentPrefix: string;
} | null;

const setProvisionalMarker = StateEffect.define<ProvisionalMarker>();

/**
 * The range of the marker Enter just inserted, for exactly as long as it is
 * still untouched and the cursor is still sitting on it. Any other edit, any
 * cursor move off the line, and this is `null` again — so every consumer below
 * is, by construction, only ever acting on text the editor itself wrote.
 */
const provisionalMarker = StateField.define<ProvisionalMarker>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setProvisionalMarker)) return effect.value;
    }
    if (!value) return null;
    if (!tr.docChanged && !tr.selection) return value;

    // `-1` on both ends keeps text typed AT the marker's end outside the range,
    // which is the whole point: the author appending to the line must not be
    // mistaken for the author rewriting the marker.
    const from = tr.changes.mapPos(value.from, -1);
    const to = tr.changes.mapPos(value.to, -1);
    if (to - from !== value.text.length) return null;
    if (tr.state.doc.sliceString(from, to) !== value.text) return null;

    const line = tr.state.doc.lineAt(from);
    if (line.from !== from) return null;

    const selection = tr.state.selection.main;
    if (!selection.empty) return null;
    if (selection.head < to || selection.head > line.to) return null;

    return { ...value, from, to };
  }
});

/** Remember the marker on the cursor's line, if that line is nothing but a marker. */
function markProvisional(view: EditorView, options?: { keepIndent?: boolean }): void {
  const selection = view.state.selection.main;
  if (!selection.empty) return;
  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return;
  if (!line.text || !MARKER_ONLY_RE.test(line.text)) return;
  const indentPrefix = options?.keepIndent ? (/^[ \t]*/.exec(line.text)?.[0] ?? '') : '';
  view.dispatch({
    effects: setProvisionalMarker.of({ from: line.from, to: line.to, text: line.text, indentPrefix })
  });
}

/**
 * Enter: run CodeMirror's own markdown continuation, then record what it wrote.
 *
 * Calling the command here rather than leaving it to `markdownKeymap` is the
 * only way to observe its result — a binding that returns `false` never learns
 * what the next handler did. Behaviour is otherwise identical: the same command
 * runs, and when it declines (plain paragraph, code block, non-markdown region)
 * this returns `false` and the rest of the Enter chain takes over exactly as
 * before.
 */
export function continueMarkup(view: EditorView): boolean {
  const handled = insertNewlineContinueMarkup({
    state: view.state,
    dispatch: (tr) => view.dispatch(tr)
  });
  if (!handled) return false;
  markProvisional(view);
  return true;
}

/**
 * Typing a marker on top of a provisional one replaces it instead of nesting under it.
 *
 * Fires on the keystroke that COMPLETES the typed marker (the space after
 * `-`, `2.`, `>`, …) and rewrites the line to exactly what the author typed —
 * their indentation included, so `"- "` + typed `"  - "` nests one level, and a
 * typed `"- "` on a provisional `"    - "` returns to the top level. What you
 * type is what the document gets.
 */
const collapseTypedMarker = EditorView.inputHandler.of((view, from, to, text) => {
  const provisional = view.state.field(provisionalMarker, false);
  if (!provisional) return false;
  // Only a single typed character at the very end of the provisional line, with
  // nothing selected. Pastes, multi-char IME commits and mid-line edits all fall
  // through to the normal path.
  if (from !== to || text.length !== 1) return false;
  const line = view.state.doc.lineAt(from);
  if (line.from !== provisional.from || from !== line.to) return false;
  if (from < provisional.to) return false;

  const prospective = line.text + text;
  if (!prospective.startsWith(provisional.text)) return false;
  const typed = prospective.slice(provisional.text.length);
  if (!TYPED_MARKER_RE.test(typed)) return false;
  const insert = provisional.indentPrefix + typed;

  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length },
    effects: setProvisionalMarker.of(null),
    userEvent: 'input.type',
    scrollIntoView: true
  });
  return true;
});

/**
 * ★ THE ORPHAN BULLET (same audit line: "it then leaves a trailing orphan bullet").
 *
 * Finishing a list with Enter — the ordinary way to finish typing a line —
 * leaves the automatic marker behind as the last line of the document. Publish
 * from there and the post renders an empty bullet nobody wrote.
 *
 * So when focus leaves the editor, a provisional marker that is (a) still
 * untouched and (b) the last line of the document is removed together with the
 * newline that introduced it. Both conditions come from `provisionalMarker`
 * itself, so this can only ever delete the editor's own insertion — never a
 * character the author typed, and never anything mid-document that they are
 * still working above.
 *
 * `document.hasFocus()` excludes the alt-tab case: switching windows also blurs
 * the content DOM, and a bullet vanishing while you are in another application
 * would be a worse surprise than the orphan itself.
 */
const dropUnusedTrailingMarker = EditorView.domEventHandlers({
  blur(_event, view) {
    const provisional = view.state.field(provisionalMarker, false);
    if (!provisional) return false;
    if (typeof document !== 'undefined' && !document.hasFocus()) return false;

    const doc = view.state.doc;
    const line = doc.lineAt(provisional.from);
    if (line.to !== doc.length) return false;
    if (line.text !== provisional.text) return false;

    view.dispatch({
      changes: { from: line.number > 1 ? line.from - 1 : line.from, to: line.to, insert: '' },
      effects: setProvisionalMarker.of(null),
      userEvent: 'delete'
    });
    return false;
  }
});

/** Everything above, minus the Enter binding — that one has to join the editor's existing Enter chain. */
export const listContinuation: Extension = [
  provisionalMarker,
  collapseTypedMarker,
  dropUnusedTrailingMarker
];

/** Exported for the outdent binding in `use-codemirror.ts`, which writes its own marker. */
export { markProvisional };
