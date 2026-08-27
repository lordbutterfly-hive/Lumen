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

  /*
   * ★ REWRITTEN 2026-08-27. These two tests asserted the policy's 12 section
   * headings and the styling of its first paragraph. That document was REMOVED on
   * the owner's instruction because it claimed Lumen collects IP addresses and
   * telephone numbers, which it does not. Counting headings that were deliberately
   * deleted would be a test defending the wrong thing, so the assertion has been
   * inverted: the page must exist, and it must make NO collection claim.
   *
   * ★ AND THE `homePage.goto()` PREAMBLE IS GONE FROM THESE TWO. It loaded the
   * signed-out HOME FEED first, which `homePage.ts:503` itself documents as taking
   * ~38-55s cold against a 60s test timeout — and it bought nothing, because
   * `moveToPrivacyPolicyPage()` opens `/login` with its own `page.goto` and never
   * looks at whatever was on screen before it. Measured: with the preamble both
   * tests died on the home feed's post cards, an assertion about neither the
   * privacy page nor this spec's subject. Dropping it removes a failure mode that
   * was never about privacy; it does not weaken a single assertion below. The
   * navigation test above keeps its preamble, because the journey IS its subject.
   */
  test('the Privacy Policy page still exists and is reachable', async ({ page }) => {
    await homePage.moveToPrivacyPolicyPage();
    await expect(privacyPolicyPage.heading).toBeVisible();
    await expect(privacyPolicyPage.firstParagraf).toBeVisible();
  });

  test('the page makes NO data-collection claim', async ({ page }) => {
    await homePage.moveToPrivacyPolicyPage();

    // ★ NON-VACUITY FIRST. Every assertion below is a NEGATIVE, and negatives all
    // pass against a page that rendered nothing at all — a 500, an empty shell or a
    // route that stopped resolving would score a clean sweep here. So prove the
    // page's OWN content is on screen before trusting anything the scan does not
    // find. `body` length alone is not enough for this: the header, nav and
    // "Log in" chrome clear any character threshold on their own, so the guard is
    // anchored to the copy this page is uniquely responsible for.
    await expect(privacyPolicyPage.heading).toBeVisible();
    await expect(privacyPolicyPage.firstParagraf).toBeVisible();
    const ownText = await privacyPolicyPage.mainElement.innerText();
    expect(ownText.length).toBeGreaterThan(80);

    // The old document's own words. If any of these come back, the page is once
    // again telling users something the product does not do. Scanned over the whole
    // body, not just the copy block: it must not reappear in a footer or a banner
    // either.
    //
    // ★ MEASURED against the pre-removal page (2026-08-27, build c1HRQ185dAkWlurXjDBxB
    // still serving the old text): 'ip address', 'telephone', 'phone number' and
    // 'what we collect' were ALL present in it, so those four are proven
    // discriminators — they fail on the exact document that had to go. 'geolocation'
    // was NOT in it; it is kept deliberately as a forward guard on the rewrite, not
    // as a claim about what was removed. Do not read it as a fifth proof.
    const body = (await page.locator('body').innerText()).toLowerCase();
    for (const claim of ['ip address', 'telephone', 'phone number', 'what we collect', 'geolocation']) {
      expect(body, `privacy page must not claim: ${claim}`).not.toContain(claim);
    }

    // and the deleted sections must really be gone, not merely restyled
    expect(await privacyPolicyPage.subtitles.count()).toBe(0);
  });

});
