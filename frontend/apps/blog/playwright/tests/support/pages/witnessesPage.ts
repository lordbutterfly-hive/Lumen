import { Locator, Page, expect } from '@playwright/test';

/**
 * ★ REWRITTEN 2026-08-11 against the CURRENT /witnesses page.
 *
 * The previous version of this class modelled the OLD external witnesses view
 * (`wallet.openhive.network/~witnesses`): a `witness-header` / `witness-table-head`
 * / `witness-list-item-info` structure, a freeform "type an account name and press
 * VOTE" box, a "Set proxy" box, and a four-column Rank / Witness / Votes received /
 * Price feed table. Every one of those testids and copy strings has zero
 * occurrences in current product source.
 *
 * The witnesses feature was not removed — it was rebuilt as a first-class in-app
 * page (`app/witnesses/page.tsx` -> `features/witnesses/*`, ~15 components) with a
 * different structure, an eight-column table, per-row vote toggles, a filters card
 * and a real proxy dialog. That is what this class now models.
 *
 * Everything here is reachable ANONYMOUSLY at `/witnesses` — no home feed, no
 * login, no new tab. Voting and proxy MUTATIONS are not modelled: they broadcast
 * `account_witness_vote` / `account_witness_proxy` and need a signed session.
 */
export class WitnessPage {
  readonly page: Page;

  /** `/witnesses` — an in-app route. NOT the old external `/~witnesses`. */
  static readonly URL = '/witnesses';

  readonly witnessesMain: Locator;
  readonly witnessesTable: Locator;
  readonly witnessRows: Locator;
  readonly witnessNameLinks: Locator;
  readonly witnessVotes: Locator;
  readonly witnessLastBlock: Locator;
  readonly witnessesLoading: Locator;
  readonly witnessesError: Locator;
  readonly witnessesEmpty: Locator;

  readonly statsBar: Locator;
  readonly filtersCard: Locator;
  readonly filterSearch: Locator;
  readonly filterVersion: Locator;
  readonly filterTop20: Locator;
  readonly filterActive: Locator;

  readonly proxyCard: Locator;
  readonly proxyLoginCta: Locator;
  readonly rightRail: Locator;

  constructor(page: Page) {
    this.page = page;

    this.witnessesMain = page.locator('[data-testid="witnesses-main"]');
    this.witnessesTable = page.locator('[data-testid="witnesses-table"]');
    this.witnessRows = page.locator('[data-testid="witness-row"]');
    this.witnessNameLinks = page.locator('[data-testid="witness-name-link"]');
    this.witnessVotes = page.locator('[data-testid="witness-votes"]');
    this.witnessLastBlock = page.locator('[data-testid="witness-last-block"]');
    this.witnessesLoading = page.locator('[data-testid="witnesses-loading"]');
    this.witnessesError = page.locator('[data-testid="witnesses-error"]');
    this.witnessesEmpty = page.locator('[data-testid="witnesses-empty"]');

    this.statsBar = page.locator('[data-testid="witnesses-stats-bar"]');
    this.filtersCard = page.locator('[data-testid="witnesses-filters-card"]');
    this.filterSearch = page.locator('[data-testid="witnesses-filter-search"]');
    this.filterVersion = page.locator('[data-testid="witnesses-filter-version"]');
    this.filterTop20 = page.locator('[data-testid="witnesses-filter-top20"]');
    this.filterActive = page.locator('[data-testid="witnesses-filter-active"]');

    this.proxyCard = page.locator('[data-testid="witnesses-proxy-card"]');
    this.proxyLoginCta = page.locator('[data-testid="witnesses-proxy-login-cta"]');
    this.rightRail = page.locator('[data-testid="witnesses-right-rail"]');
  }

  /** Per-row vote toggle: `witness-vote-<account>` (witness-vote-toggle.tsx:51). */
  voteToggleFor(witness: string): Locator {
    return this.page.locator(`[data-testid="witness-vote-${witness}"]`);
  }

  /**
   * Deep link straight to the page, then wait for the CLIENT fetch to land.
   * The shell and the table container are server-rendered, but rows arrive from
   * a React Query fetch, so `witnesses-loading` must clear before any row
   * assertion — otherwise a row count of 0 is just "not fetched yet".
   */
  async goto() {
    await this.page.goto(WitnessPage.URL);
    await this.page.waitForLoadState('domcontentloaded');
    await expect(this.witnessesTable).toBeVisible();
    await expect(this.witnessesLoading).toHaveCount(0, { timeout: 30000 });
  }
}
