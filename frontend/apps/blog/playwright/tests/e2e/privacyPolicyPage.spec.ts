import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { PrivacyPolicyPage } from '../support/pages/privacyPolicyPage';

test.describe('Privacy Policy page tests', () => {
  let homePage: HomePage;
  let privacyPolicyPage: PrivacyPolicyPage;

  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);
    privacyPolicyPage = new PrivacyPolicyPage(page);
  });

  test('move to the Privacy Policy page from the Home page', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToPrivacyPolicyPage();
  });

  test('validate amount of subtitles in the Privacy Policy', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToPrivacyPolicyPage();

    /*
     * ★ 11 -> 12 (2026-08-21). This counts `h3[class="mb-4 text-3xl"]`, the policy's
     * section headings, and the document gained one since the number was written.
     * Counted three ways to be sure the locator and the content agree: the selector
     * resolves to 12, the page has exactly 12 `<h3>` in total, and the 12 headings
     * are WHAT WE COLLECT ... NOTICE TO EU DATA SUBJECTS. (A raw grep for the class
     * STRING in the HTML returns 19, but that class is also on `<h2>`, `<ul>` and
     * `<span>` elements — it is not the count this locator makes.)
     */
    const subtitlesAmount = await (await privacyPolicyPage.subtitles.all()).length;
    expect(subtitlesAmount).toBe(12);
  });

  test('validate styles in the Privacy Policy in the light mode', async ({ page }) => {
    await homePage.goto();
    await homePage.moveToPrivacyPolicyPage();

    // Validate subtitle styles of the privacy policy page
    const subtitleColor = await privacyPolicyPage.getElementCssPropertyValue(
      privacyPolicyPage.firstSubtitle,
      'color'
    );
    expect(subtitleColor).toBe('rgb(0, 0, 0)');
    const subtitleFontSize = await privacyPolicyPage.getElementCssPropertyValue(
      privacyPolicyPage.firstSubtitle,
      'font-size'
    );
    expect(subtitleFontSize).toBe('30px');
    const backgroundColorPage = await privacyPolicyPage.getElementCssPropertyValue(
      privacyPolicyPage.mainElement,
      'background-color'
    );
    expect(backgroundColorPage).toBe('rgba(0, 0, 0, 0)');
    const paragrafColor = await privacyPolicyPage.getElementCssPropertyValue(
      privacyPolicyPage.firstParagraf,
      'color'
    );
    expect(paragrafColor).toBe('rgb(0, 0, 0)');
    const paragrafFontSize = await privacyPolicyPage.getElementCssPropertyValue(
      privacyPolicyPage.firstParagraf,
      'font-size'
    );
    /*
     * ★ 14px -> 15px (2026-08-21). Not drift and not a regression: this page's copy
     * is wrapped in `text-body-sm` (app/privacy.html/page.tsx:4), and the type scale
     * deliberately moved that token — `packages/tailwindcss/tailwind.config.js:188`
     * reads `'body-sm': ['15px', '22px'], // was 14`. Measured on the live page: the
     * targeted element computes to 15px, colour unchanged at rgb(0, 0, 0).
     */
    expect(paragrafFontSize).toBe('15px');
  });

});
