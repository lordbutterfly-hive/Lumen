import { Locator, Page, expect } from '@playwright/test';
import { HomePage } from './homePage';

export class UnmoderatedTagPage {
  readonly page: Page;
  readonly homePage: HomePage;
  readonly unmoderatedTag: Locator;
  readonly unmoderatedTagHeader: Locator;
  readonly firstPostAuthor: Locator;
  readonly firstPostTitle: Locator;
  readonly firstPostSummary: Locator;
  readonly firstPostCardFooter: Locator;
  readonly firstPostCardFooterDeclinePayout: Locator;
  readonly secondPostAuthor: Locator;
  readonly secondPostTitle: Locator;
  readonly secondPostSummary: Locator;
  readonly firstPostCardPoweredUp100Trigger: Locator;
  readonly firstPostCardPoweredUp100TriggerLink: Locator;
  readonly postCardPoweredUp100Tooltip: Locator;

  constructor(page: Page) {
    this.page = page;
    this.homePage = new HomePage(page);

    this.unmoderatedTag = page.getByTestId('community-name');
    this.unmoderatedTagHeader = page.getByTestId('community-name-unmoderated');
    // `medium-card-author` no longer exists — the byline is now
    // `identity-pill-profile` (features/discovery-feed/identity-pill.tsx),
    // which renders "@handle" (leading @), unlike the old bare-handle testid.
    this.firstPostAuthor = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .first()
      .locator('[data-testid="post-author"], [data-testid="identity-pill-profile"]');
    this.firstPostTitle = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .first()
      .locator('[data-testid="post-title"], [data-testid="medium-card-title"]');
    this.firstPostSummary = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .first()
      .locator('[data-testid="post-description"], [data-testid="medium-card-dek"]');
    this.firstPostCardFooter = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .first()
      .locator('[data-testid="post-card-footer"], [data-testid="medium-card-footer"]');
    this.firstPostCardFooterDeclinePayout = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .first()
      .locator('[data-testid="post-card-footer"], [data-testid="medium-card-footer"]')
      .locator('[data-testid="post-payout-decline"]');
    this.secondPostAuthor = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .nth(1)
      .locator('[data-testid="post-author"], [data-testid="identity-pill-profile"]');
    this.secondPostTitle = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .nth(1)
      .locator('[data-testid="post-title"], [data-testid="medium-card-title"]');
    this.secondPostSummary = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .nth(1)
      .locator('[data-testid="post-description"], [data-testid="medium-card-dek"]');
    this.firstPostCardPoweredUp100Trigger = page
      .locator('[data-testid="post-list-item"], [data-testid="medium-card"]')
      .first()
      .locator('[data-testid="powered-up-100-trigger"]');
    this.firstPostCardPoweredUp100TriggerLink = this.firstPostCardPoweredUp100Trigger.locator('a');
    this.postCardPoweredUp100Tooltip = page.locator('[data-testid="powered-up-100-tooltip"]');
  }

  async validateUnmoderatedTagPageIsLoaded(postTag: string) {
    //
    await this.page.waitForTimeout(5000);
    await this.page.waitForLoadState('domcontentloaded');
    // Validate that user has been moved to the unmoderated tag page
    expect(await this.unmoderatedTagHeader.textContent()).toBe('Unmoderated tag');
    expect(await this.unmoderatedTag.textContent()).toBe(`#${postTag}`);
  }

  async validateFirstPostInTheUnmoderatedTagList(author: string, postTitle: string, postSummary: string) {
    // Validate the first post on the unmoderated post list
    // Validate post's author name — `identity-pill-profile` renders "@handle"
    // (leading @), unlike the old bare-handle `medium-card-author`; strip it so
    // this still compares the real handle, not weaker text.
    const authorText = await this.firstPostAuthor.textContent();
    expect(authorText?.replace(/^@/, '')).toBe(author);
    // Validate the first post's title — on the Lumen card `firstPostTitle`'s
    // <h2> renders the headline AND the inline post date as sibling <span>s
    // with no separator (medium-post-card.tsx), so raw textContent would be
    // "TitleTimeAgo". Isolate the title's own (first) span there; the classic
    // `post-title` card has no such span and its full textContent is already
    // clean, so this falls back to it when no span is found.
    const titleSpan = this.firstPostTitle.locator('h2 > span').first();
    const titleText = (await titleSpan.count())
      ? await titleSpan.textContent()
      : await this.firstPostTitle.textContent();
    expect(titleText).toBe(postTitle);
    // Validate the first post's summary description
    expect(await this.firstPostSummary.textContent()).toBe(postSummary);
  }
}
