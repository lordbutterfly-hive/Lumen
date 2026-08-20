import { Locator, Page, expect } from '@playwright/test';

export class TOSPage {
  readonly page: Page;
  readonly subtitles: Locator;
  readonly firstSubtitle: Locator;
  readonly mainElement: Locator;
  readonly paragrafText: Locator;
  readonly navPostLink: Locator;
  readonly navProposalsLink: Locator;
  readonly navWitnessesLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.subtitles = page.locator('[id="articleBody"] h2');
    this.firstSubtitle = this.subtitles.first();
    this.mainElement = page.locator('#articleBody');
    this.paragrafText = page.getByText('If we decide to make changes to this Agreement');
    this.navPostLink = this.page.locator('[data-testid="left-rail-home"]');
    this.navProposalsLink = this.page.locator('[data-testid="left-rail-vote-proposals"]');
    this.navWitnessesLink = this.page.locator('[data-testid="left-rail-vote-witness"]');
  }

  async getElementCssPropertyValue(element: Locator, cssProperty: string) {
    const propertyValue = await element.evaluate((ele, css) => {
      return window.getComputedStyle(ele).getPropertyValue(css);
    }, cssProperty);
    // return value of element's css property
    return propertyValue;
  }
}
