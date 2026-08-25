/**
 * Open a feed card's top-comment drawer, the way a reader now does: by CLICKING
 * the card's empty space.
 *
 * ★★★ WHY THIS HELPER EXISTS (2026-08-25). The drawer used to open on HOVER
 * after a 350ms dwell, and every QA script here opened it by parking the mouse
 * on the card and waiting. Owner ruling replaced that with click-to-open ("the
 * hover over doesnt work well its annoying. only on clicking empty card it
 * should show drop down"), which made every one of those scripts assert a
 * behaviour that no longer exists.
 *
 * ★ "Empty space" is not a fixed offset. The old scripts used
 * `b.y + 40`, which is fine for a hover — any pixel of the card would do — but
 * as a CLICK target it is the byline row, where it would land on the identity
 * pill or the community tag and navigate instead of opening anything. So this
 * probes for a point that is inside the card, hit-tests to a node the card
 * contains, and is not inside any control or the drawer itself — the same test
 * the card's own click handler applies.
 */

/**
 * Find a clickable empty point inside `card` (a Playwright LOCATOR), or null.
 * Locator rather than a selector because that is what every caller already has.
 */
export async function emptyPointIn(card) {
  return card.evaluate((el) => {
    const cardEl = el;
    if (!cardEl) return null;
    const r = cardEl.getBoundingClientRect();
    // Scan the text column, below the byline and above the action row.
    for (let fy = 0.3; fy <= 0.75; fy += 0.05) {
      for (let fx = 0.1; fx <= 0.6; fx += 0.05) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !cardEl.contains(hit)) continue;
        if (hit.closest('a, button, input, select, textarea, label, [role="button"], [role="link"]')) continue;
        if (hit.closest('[data-testid="post-card-drawer"]')) continue;
        return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return null;
  });
}

/** The drawer's reported state for a card locator. */
async function drawerState(card) {
  return card
    .locator('[data-testid="post-card-drawer"]')
    .getAttribute('data-open')
    .catch(() => null);
}

/** Click empty space and wait for the drawer to report open. Returns true on success. */
export async function openCardDrawer(page, card, timeoutMs = 12000) {
  const pt = await emptyPointIn(card);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await drawerState(card)) === 'true') return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/** Close it again — a second click on the same empty space. */
export async function closeCardDrawer(page, card, timeoutMs = 4000) {
  const pt = await emptyPointIn(card);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await drawerState(card)) === 'false') return true;
    await page.waitForTimeout(120);
  }
  return false;
}
