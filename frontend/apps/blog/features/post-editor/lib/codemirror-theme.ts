import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";

export const lightTheme = EditorView.theme({
  "&": {
    backgroundColor: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
  },
  ".cm-content": {
    caretColor: "hsl(var(--foreground))",
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: "14px",
    lineHeight: "1.6",
  },
  ".cm-cursor": {
    borderLeftColor: "hsl(var(--foreground))",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "hsl(var(--accent))",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "hsl(var(--accent) / 0.3)",
  },
  ".cm-scroller": {
    overflow: "auto",
  },
  ".cm-matchingBracket": {
    backgroundColor: "hsl(var(--accent))",
    outline: "none",
  },
  ".cm-selectionMatch": {
    backgroundColor: "hsl(var(--accent) / 0.5)",
  },
  /**
   * ★ THE BRAND FOCUS RING, NOT CODEMIRROR'S OWN (a11y item 6/O5). Without
   * this, `@codemirror/view`'s baseTheme draws its library-default
   * `1px dotted #212121` outline on `.cm-editor.cm-focused` -- that outline
   * is drawn on the `.cm-editor` ANCESTOR, not on `.cm-content` (the node
   * that actually receives focus), so this needs its own rule rather than
   * relying on the browser default. `EditorView.theme` extensions take
   * precedence over the library's `baseTheme`, so overriding it here (not in
   * globals.css) is deterministic regardless of CodeMirror's own StyleModule
   * injection order.
   *
   * `hsl(var(--ring))`, not a literal hex: `--ring` is the one token every
   * other focus ring in the app now reads (globals.css), including its
   * lighter dark-mode value -- so this stays in sync with the brand ring
   * automatically and needs no separate dark-mode override. Confirmed
   * `oneDark` (layered on top in dark mode, see `darkCompartment` in
   * `use-codemirror.ts`) defines no `.cm-focused` outline of its own, so
   * this rule is not shadowed there.
   *
   * ★ THIS IS NOW THE ONLY OUTLINE `.cm-content` GETS (2026-08-16, M3 fix).
   * `globals.css`'s app-wide `:focus-visible` rule matches `.cm-content`
   * directly (it is a real `contenteditable` node and receives real focus),
   * and it used to fire ALONGSIDE this rule -- two outlines, both 2px, both
   * offset 2px, one on `.cm-content` and one on its `.cm-editor` parent,
   * landing close enough to read as one thicker red line directly under
   * `EditorToolbar`. `globals.css` now excludes `[contenteditable]`
   * specifically so this rule is the single source of the editor's focus
   * indicator, the same way a `focus-visible:ring-2` component excludes
   * itself by out-prioritising the global rule's `@layer base`.
   */
  "&.cm-focused": {
    outline: "2px solid hsl(var(--ring))",
    outlineOffset: "2px",
  },
});

export const darkCompartment = new Compartment();

export function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}
