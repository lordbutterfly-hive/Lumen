import { type Locator, type Page } from '@playwright/test';

/**
 * ★★★ REBUILT FOR THE SINGLE-FIELD SEARCH (owner ruling, 2026-08-10).
 *
 * The scope dropdown (`role="combobox"`, `search-mode-*` options), the second
 * "Topic..." box, and the `@`/`#`/`/`/`%` prefix modes are all gone — see
 * `packages/ui/hooks/use-search.ts` and `features/search/search-input.tsx`.
 * Search is one field (`header-search-input`, in the site header, present on
 * every page — `/search` itself renders no field of its own) driving
 * `/search?q=...&s=...`. Results render `MediumPostCard`
 * (`data-testid="medium-card"`), the feed's own card, not the classic
 * `post-list-item`. The sort control survives as a native `<select
 * data-testid="search-sort-by-dropdown-list">` (`features/search/sort-select.tsx`),
 * not a Radix trigger with `[role="option"]` children.
 */
export class SearchPage {
  readonly page: Page;

  // Search input and control — the one header search field.
  readonly searchInput: Locator;
  readonly searchButton: Locator;

  // Sort select (native <select>, not a Radix combobox).
  readonly sortSelectTrigger: Locator;

  // Search results — MediumPostCard.
  readonly postListItems: Locator;
  readonly firstPostItem: Locator;
  readonly firstPostTitle: Locator;
  readonly firstPostAuthor: Locator;

  // Loading and empty states
  readonly noResultsMessage: Locator;

  constructor(page: Page) {
    this.page = page;

    // The only search field left (header-mounted; see features/search/search-input.tsx).
    this.searchInput = page.getByTestId('header-search-input');
    // No testid on the submit button; it is the input's sibling in the same
    // pill, so this holds regardless of the (translated) aria-label text.
    this.searchButton = this.searchInput.locator('xpath=following-sibling::button');

    // Sort select — id unchanged across the Radix -> native swap.
    this.sortSelectTrigger = page.getByTestId('search-sort-by-dropdown-list');

    // Search results — MediumPostCard (features/discovery-feed/medium-post-card.tsx).
    this.postListItems = page.locator('[data-testid="medium-card"]');
    this.firstPostItem = this.postListItems.first();
    this.firstPostTitle = this.firstPostItem.locator('[data-testid="medium-card-title"]');
    this.firstPostAuthor = this.firstPostItem.locator('[data-testid="medium-card-author"]');

    // Actual copy (locales/en/common_blog.json, search_page.no_results_for):
    // `No results for "{{query}}". Try different or fewer words.`
    this.noResultsMessage = page.getByText(/no results/i);
  }

  async goto() {
    await this.page.goto('/search');
    await this.page.waitForLoadState('domcontentloaded');
  }

  async gotoWithClassicQuery(query: string, sort: 'relevance' | 'created' = 'relevance') {
    await this.page.goto(`/search?q=${encodeURIComponent(query)}&s=${sort}`);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async performSearch(query: string) {
    await this.searchInput.fill(query);
    await this.searchButton.click();
    await this.page.waitForLoadState('domcontentloaded');
  }

  async performSearchWithEnter(query: string) {
    await this.searchInput.fill(query);
    await this.searchInput.press('Enter');
    await this.page.waitForLoadState('domcontentloaded');
  }

  /** Native <select> — use selectOption, there is no floating listbox to click through. */
  async selectSort(sort: 'relevance' | 'created') {
    await this.sortSelectTrigger.selectOption(sort);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async waitForSearchResults(timeout: number = 15000): Promise<'results' | 'empty' | 'timeout'> {
    // Wait for results to appear or no results message
    try {
      await Promise.race([
        this.firstPostItem.waitFor({ state: 'visible', timeout }),
        this.noResultsMessage.waitFor({ state: 'visible', timeout })
      ]);
      // Determine which state we're in
      if (await this.firstPostItem.isVisible()) {
        return 'results';
      }
      return 'empty';
    } catch {
      // Timeout reached - return explicit state for test to handle
      return 'timeout';
    }
  }

  async getResultsCount(): Promise<number> {
    // Wait for either results or empty state to stabilize
    await this.page.waitForLoadState('networkidle');
    return await this.postListItems.count();
  }

  async clickFirstResult() {
    await this.firstPostTitle.click();
    await this.page.waitForSelector('[data-testid="article-title"]', { timeout: 15000 });
  }

  async clickFirstResultAuthor() {
    await this.firstPostAuthor.click();
    // The redesigned profile carries no "profile-name" testid (2026-08-10
    // redesign, features/account-profile/redesign/*) — profile-stats is the
    // stable element every profile view still renders.
    await this.page.waitForSelector('[data-testid="profile-stats"]', { timeout: 15000 });
  }

  async scrollToLoadMore() {
    const initialCount = await this.postListItems.count();
    await this.page.keyboard.press('End');
    // Wait for new items to load or network to settle
    try {
      await this.page.waitForFunction(
        (initial) => document.querySelectorAll('[data-testid="medium-card"]').length > initial,
        initialCount,
        { timeout: 10000 }
      );
    } catch {
      // No new items loaded - that's acceptable, test will verify count
      await this.page.waitForLoadState('networkidle');
    }
  }

  // Helpers
  async getElementCssPropertyValue(element: Locator, cssProperty: string): Promise<string> {
    return await element.evaluate((ele, css) => {
      return window.getComputedStyle(ele).getPropertyValue(css);
    }, cssProperty);
  }

  async isInputEnabled(): Promise<boolean> {
    return await this.searchInput.isEnabled();
  }

  async getInputPlaceholder(): Promise<string | null> {
    return await this.searchInput.getAttribute('placeholder');
  }
}
