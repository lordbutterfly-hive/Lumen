# Charter: on a phone

## Mission
Drive the core journeys at a phone viewport (390×844) and a tablet one
(820×1180): read the feed, open a post, write one, use the header and the menus.
No tester has ever looked at Lumen at any size but a desktop window.

## Risk oracles
- **Something is unreachable.** A control off-screen, behind an overlay, or too
  small to hit; a menu that cannot be closed.
- **Horizontal scrolling.** The body should never scroll sideways.
- **Overlap or clipping.** Text over text, cut-off numbers, a modal taller than
  the screen with no way to scroll or dismiss it.
- **The composer and the picker.** Both are full-width modals on desktop; check
  they are usable, dismissible, and do not trap focus on a small screen.
