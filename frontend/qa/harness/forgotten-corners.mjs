/**
 * HARNESS — the corners nobody has looked at in three rounds.
 *
 * Keyboard-only use, focus traps, labels, the logged-out/public view, settings,
 * wallet, the language toggle, notifications, and the moderation + publishing
 * pipeline that puts content on a PERMANENT public ledger.
 */
import { openApp, visit, BASE } from '../../qa-harness.mjs';

export { openApp, visit, BASE };

/** Walk the page with Tab only and report what a keyboard user reaches. */
export async function tabWalk(page, steps = 30) {
  const seen = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      return {
        tag: a.tagName,
        name: (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 40),
        visible: !!(a.getBoundingClientRect().width || a.getBoundingClientRect().height)
      };
    });
    seen.push(el);
  }
  return seen;
}

/** Can focus escape this dialog with Tab, and does Escape close it? */
export async function focusTrapCheck(page) {
  const before = await page.locator('[role="dialog"], [role="alertdialog"]').count();
  if (!before) return { dialog: false };
  const inside = [];
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    inside.push(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"],[role="alertdialog"]')));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const after = await page.locator('[role="dialog"], [role="alertdialog"]').count();
  return { dialog: true, escapedFocus: inside.includes(false), closesOnEscape: after < before };
}

/** Controls a screen reader would announce as nothing. */
export async function unlabelled(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], input, select, textarea')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return false;
        const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
        return name.length === 0;
      })
      .map((el) => `${el.tagName}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`)
      .slice(0, 25)
  );
}

/** How many publish jobs are still queued — the pipeline's own backlog. */
export async function publishBacklog() {
  const { execSync } = await import('child_process');
  try {
    return execSync(
      `docker exec lumen-b12-pg psql -U qa -d lite -tAc "select status||'='||count(*) from publish_job group by status"`,
      { encoding: 'utf8' }
    ).trim().replace(/\n/g, ' ');
  } catch (e) {
    return 'unavailable: ' + String(e).slice(0, 60);
  }
}
