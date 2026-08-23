import { expect, test } from '@playwright/test';
import { HomePage } from '../support/pages/homePage';
import { LoginForm } from '../support/pages/loginForm';
import { ProfileUserMenu } from '../support/pages/profileUserMenu';

test.describe('Login and Sign Up tests', () =>{
  let homePage: HomePage;

  const user = {
    username: process.env.CI_TEST_USER as string,
    password: 'testtest',
    keys: [
        {
            type: 'posting',
            private: process.env.CI_TEST_USER_WIF_POSTING as string
        },
        {
            type: 'active',
            private: process.env.CI_TEST_USER_WIF_ACTIVE as string
        }
    ],
  }


  test.beforeEach(async ({ page }) => {
    homePage = new HomePage(page);

    await homePage.goto();
  });

  test('Clicking the login control opens the sign-in page', async ({page}) =>{
    const loginFormDefaut = new LoginForm(page);

    await homePage.loginBtn.click()
    await loginFormDefaut.validateDefaultLoginFormIsLoaded();
  })
  // -- The two happy-path sign-in tests that stood here were RETIRED 2026-08-21.
  //    They filled a username + password + WIF posting key form and pressed
  //    Save & Sign In. Lumen offers no WIF path at all: keychain-signin.tsx names
  //    Keychain "the ONLY Hive-key path Lumen offers", and /login renders just the
  //    Keychain and Google rows. The form those tests typed into does not exist,
  //    so they asserted a capability that was deliberately removed rather than a
  //    regression. Their assertions are recorded in RETIRED-TESTS-2026-08-21.md.
  //    Driving Keychain needs a browser extension fixture, which this suite has
  //    no harness for; that is the work required to restore sign-in coverage.

  // --

  // Account name should not be empty.   - Wrong username
  // Account name should be longer. - Wrong username
  // Password length should be at least 6 characters - Wrong password
  // WIF should not be empty. - Wrong WIF (needs username)
  // Invalid WIF key. - Wrong WIF (needs username)
  // No WIF key from user - in the other sign in options form
  // Invalid WIF key. - in Enter your WIF key

});
