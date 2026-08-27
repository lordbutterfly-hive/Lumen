import { Locator, Page, expect } from '@playwright/test';

export class PrivacyPolicyPage {
  readonly page: Page;
  readonly subtitles: Locator;
  readonly firstSubtitle: Locator;
  readonly mainElement: Locator;
  readonly firstParagraf: Locator;
  readonly heading: Locator;
  readonly navPostLink: Locator;
  readonly navProposalsLink: Locator;
  readonly navWitnessesLink: Locator;

  constructor(page: Page) {
    this.page = page;
    // ★ RETARGETED 2026-08-27. The policy TEXT was removed on the owner's
    // instruction (it described collection Lumen does not do), so the section
    // headings these locators counted no longer exist. `subtitles` is kept so the
    // suite can assert there are NONE, which is now the meaningful check.
    this.subtitles = this.page.locator('h3[class="mb-4 text-3xl"]');
    this.firstSubtitle = this.subtitles.first();
    this.mainElement = this.page.locator('.mb-4.max-w-2xl.text-body-sm');
    this.heading = this.page.getByRole('heading', { name: 'Privacy Policy', level: 1 });
    this.firstParagraf = this.page.getByText('This policy is being rewritten');
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
