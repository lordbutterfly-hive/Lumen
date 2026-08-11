import { expect, test } from '@playwright/test';
import { WitnessPage } from '../support/pages/witnessesPage';

/**
 * ★ UNSKIPPED AND REWRITTEN 2026-08-11.
 *
 * Old state: `test.describe.skip('Witnesses page tests')`, 11 tests, reason
 * "Below test were passing but due to back to the old view of hive blog are
 * skipped."
 *
 * That reason has the direction backwards. Nothing went "back to the old view".
 * The witnesses page went FORWARD: the old spec drove an EXTERNAL wallet page at
 * `/~witnesses` (freeform vote box, "Set proxy" box, four columns: Rank / Witness
 * / Votes received / Price feed), reached by clicking a nav link that opened a new
 * browser tab. All of that is gone. `/witnesses` is now a first-class in-app route
 * (app/witnesses/page.tsx -> features/witnesses/*, ~15 components) with an
 * eight-column table, per-row vote toggles, a filters card, a stats bar and a real
 * proxy dialog. `left-rail.tsx:225-227` documents the move in so many words.
 *
 * So every locator and every copy string in the old spec was dead — `witness-header`,
 * `witness-table-head`, `witness-list-item-info`, `witnesses-vote-box`,
 * `witness-votes-received`, `last-block-number`, "Witness Voting", "You have 30
 * votes remaining...", the 120-row count — none of them exist. It could not be
 * patched; it was rewritten against the shipped markup (see the page object).
 *
 * SCOPE: everything below is anonymous and deep-linked to `/witnesses`. It does
 * NOT route through the home feed, so it does not pay that page's cold-start cost.
 * Vote / proxy MUTATIONS are deliberately not covered here — they broadcast
 * `account_witness_vote` / `account_witness_proxy` and need a signed session;
 * that belongs in an authenticated spec using support/fixture-auth/seeder.ts.
 * Named as a real coverage gap rather than faked with a skipped test.
 */
test.describe('Witnesses page tests', () => {
  let witnessPage: WitnessPage;

  test.beforeEach(async ({ page }) => {
    witnessPage = new WitnessPage(page);
  });

  test('witnesses page loads at its in-app route', async ({ page }) => {
    await witnessPage.goto();
    // In-app, same tab, no `~`. The old spec expected a NEW TAB at `/~witnesses`.
    await expect(page).toHaveURL(/\/witnesses$/);
    await expect(witnessPage.witnessesMain).toBeVisible();
  });

  test('validate witness page header', async ({ page }) => {
    await witnessPage.goto();
    // witnesses.title + witnesses.subtitle, rendered by
    // features/witnesses/witnesses-header.tsx:27-33 via PageMasthead.
    await expect(page.getByRole('heading', { name: /Witnesses/ })).toBeVisible();
    await expect(page.getByText('Block Producers')).toBeVisible();
    await expect(
      page.getByText('Witnesses run consensus nodes and secure the chain', { exact: false })
    ).toBeVisible();
  });

  test('validate the stats bar is visible', async ({ page }) => {
    await witnessPage.goto();
    await expect(witnessPage.statsBar).toBeVisible();
    // Signed out, the vote slot is a "Log in to vote for witnesses" CTA, so the
    // logged-in-only `witnesses-stats-votes-left` must NOT be present.
    await expect(page.getByText('Log in to vote for witnesses')).toBeVisible();
    await expect(page.locator('[data-testid="witnesses-stats-votes-left"]')).toHaveCount(0);
  });

  test('validate the witness table renders rows', async ({ page }) => {
    await witnessPage.goto();
    await expect(witnessPage.witnessesTable).toBeVisible();
    await expect(witnessPage.witnessesError).toHaveCount(0);
    await expect(witnessPage.witnessesEmpty).toHaveCount(0);

    // The table paginates client-side: FIRST_PAGE = 60 rows, then +60 on scroll
    // (witnesses-table.tsx:46-47). Assert the first page really filled rather
    // than pinning an exact total, which is chain data and moves.
    const rowCount = await witnessPage.witnessRows.count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThanOrEqual(60);
  });

  /**
   * ★★★ THIS TEST CURRENTLY FAILS, AND IT IS RIGHT TO FAIL. DO NOT WEAKEN IT.
   *
   * It is red because of a live layout defect in the witnesses table, found by
   * un-skipping this file on 2026-08-11. The "Witness" identity column collapses
   * to ZERO WIDTH at common desktop widths, taking the avatar, the account name
   * and the profile link with it — not just the header label.
   *
   * Measured (chromium, /witnesses, first data row's identity cell):
   *   viewport 1279 -> 315px   (fine)
   *   viewport 1280 ->   0px   <-- names invisible
   *   viewport 1300 ->   0px
   *   viewport 1320 ->   0px
   *   viewport 1366 ->  46px   (present but unusably truncated)
   *
   * MECHANISM (all three lines are needed to produce it):
   *   1. features/witnesses/witnesses-shell.tsx:73 — at `xl` (1280px) the page grid
   *      becomes `xl:grid-cols-[200px_minmax(0,1fr)_312px]`, i.e. a 312px right rail
   *      appears. At vw=1280 that leaves the main column 592px
   *      (1280 - 88 padding - 200 rail - 312 rail - 88 gaps).
   *   2. features/witnesses/lib/table-grid.tsx:33 — `GENERAL_MIN_WIDTH_CLASS` is
   *      `min-w-[820px] lg:min-w-0`, so the 820px floor that protects the columns is
   *      already switched OFF at `lg` (1024px), 256px before the rail arrives. Its own
   *      comment states the assumption that fails here: "hands the layout straight
   *      back to the grid at >=1024px, where ... nothing about the desktop table
   *      changes". Something does change at 1280: the rail.
   *   3. features/witnesses/witnesses-table.tsx:108 — `overflow-x-auto lg:overflow-visible`
   *      removes the table's own horizontal scroller at that same `lg`, so there is
   *      no fallback either.
   *   The seven fixed tracks need 632px (table-grid.tsx:29 does this arithmetic).
   *   With 592px available, `minmax(0,1fr)` legally resolves to 0.
   *
   * The band is roughly 1280px <= vw < ~1400px, which includes 1280x720 and 1366x768 —
   * two of the most common laptop resolutions — and 1280x720 is also Playwright's
   * `devices['Desktop Chrome']` viewport, which is why this surfaced here first.
   * (Note that project viewport overrides `use.viewport: 1920x1080` in
   * playwright.config.ts:72, so the suite runs at the broken width by default.)
   *
   * SUGGESTED FIX (product side, not mine to make): keep the min-width floor and the
   * scroller until the rail is gone — e.g. `min-w-[820px] xl:min-w-0` is still wrong
   * because the rail arrives AT xl; the floor needs to survive the rail, or the rail
   * needs its own breakpoint above the point where 200+312+632+padding fits.
   */
  test('validate the witness table column headers', async ({ page }) => {
    await witnessPage.goto();
    const header = witnessPage.witnessesTable.locator('[role="row"]').first();
    // witnesses.columns.* — the current eight-column set. The old spec asserted
    // four: Rank / Witness / Votes received / Price feed.
    for (const label of ['#', 'Witness', 'Votes', 'Last block', 'Miss', 'Price', 'HBD APR', 'Vote']) {
      await expect(header.getByText(label, { exact: true })).toBeVisible();
    }
  });

  /**
   * ★★★ ALSO CURRENTLY FAILING BY DESIGN — the same defect, at the severity that
   * actually matters to a reader: the witness NAME is unreadable, not just its
   * column label. Kept separate so the header-label symptom and the data symptom
   * are not confused for one flake. See the note above for the mechanism.
   */
  test('the witness identity column is wide enough to read', async ({ page }) => {
    await witnessPage.goto();
    const identityCell = witnessPage.witnessRows.first().locator('> *').nth(1);
    const box = await identityCell.boundingBox();
    expect(box).not.toBeNull();
    // 188px is the product's own stated minimum for "avatar + name + version chip"
    // (features/witnesses/lib/table-grid.tsx:29-30).
    expect(box!.width).toBeGreaterThanOrEqual(188);
  });

  test('validate the first witness row exposes its identity and numbers', async ({ page }) => {
    await witnessPage.goto();
    const firstRow = witnessPage.witnessRows.first();
    await expect(firstRow).toBeVisible();

    const nameLink = firstRow.locator('[data-testid="witness-name-link"]');
    await expect(nameLink).toBeVisible();
    const name = (await nameLink.textContent())?.trim() ?? '';
    expect(name.length).toBeGreaterThan(0);

    await expect(firstRow.locator('[data-testid="witness-votes"]')).toBeVisible();
    // Renamed from `last-block-number`, and it is now a link to hiveblocks.com
    // showing a relative age rather than a raw `#<blocknum>`.
    await expect(firstRow.locator('[data-testid="witness-last-block"]')).toBeVisible();
  });

  test('witness name links to that witness profile', async ({ page }) => {
    await witnessPage.goto();
    const nameLink = witnessPage.witnessNameLinks.first();
    const name = (await nameLink.textContent())?.trim().replace(/^@/, '') ?? '';
    expect(name.length).toBeGreaterThan(0);
    await expect(nameLink).toHaveAttribute('href', new RegExp(`@${name}`));
  });

  test('validate the filters card and its controls', async ({ page }) => {
    await witnessPage.goto();
    await expect(witnessPage.filtersCard).toBeVisible();
    await expect(witnessPage.filterSearch).toBeVisible();
    await expect(witnessPage.filterVersion).toBeVisible();
    await expect(witnessPage.filterTop20).toBeVisible();
    await expect(witnessPage.filterActive).toBeVisible();
  });

  test('searching the filter narrows the witness list', async ({ page }) => {
    await witnessPage.goto();
    const before = await witnessPage.witnessRows.count();
    expect(before).toBeGreaterThan(1);

    const target = (await witnessPage.witnessNameLinks.first().textContent())?.trim().replace(/^@/, '') ?? '';
    expect(target.length).toBeGreaterThan(0);

    await witnessPage.filterSearch.fill(target);
    await expect(witnessPage.witnessRows).not.toHaveCount(before);
    expect(await witnessPage.witnessRows.count()).toBeGreaterThan(0);
    await expect(witnessPage.witnessNameLinks.first()).toContainText(target);
  });

  test('signed out, the proxy card offers a login CTA and no proxy mutation', async ({ page }) => {
    await witnessPage.goto();
    await expect(witnessPage.proxyCard).toBeVisible();
    // features/witnesses/witnesses-proxy-card.tsx:45 — anonymous branch.
    await expect(witnessPage.proxyLoginCta).toBeVisible();
    // The set/clear buttons are logged-in only; they must not be reachable here.
    await expect(page.locator('[data-testid="witnesses-proxy-set-cta"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="witnesses-proxy-clear-cta"]')).toHaveCount(0);
  });

  test('every rendered row carries a vote toggle', async ({ page }) => {
    await witnessPage.goto();
    const rows = await witnessPage.witnessRows.count();
    expect(rows).toBeGreaterThan(0);
    // `witness-vote-<account>` (witness-vote-toggle.tsx). One per row — this is
    // the replacement for the removed freeform "type a name and press VOTE" box.
    const toggles = await page.locator('[data-testid^="witness-vote-"]').count();
    expect(toggles).toBe(rows);
  });
});
