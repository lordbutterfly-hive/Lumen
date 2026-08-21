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

  test('Check if after click login button correct modal is open', async ({page}) =>{
    const loginFormDefaut = new LoginForm(page);

    await homePage.loginBtn.click()
    await loginFormDefaut.validateDefaultLoginFormIsLoaded();
  })

  // -- Happy path for Sign in, Logout and Login
  test('Sign In to the Denser App', async ({page}) =>{
    const loginFormDefaut = new LoginForm(page);
    const profileMenu = new ProfileUserMenu(page);

    await homePage.loginBtn.click()
    await loginFormDefaut.validateDefaultLoginFormIsLoaded();
    // Sign In
    await loginFormDefaut.usernameInput.fill(user.username);
    await loginFormDefaut.passwordInput.fill(user.password);
    await loginFormDefaut.wifInput.fill(user.keys[0].private); // Posting Key
    await loginFormDefaut.saveSignInButton.click();
    await homePage.profileAvatarButton.click();
    // Validate User is logged in
    await page.waitForSelector(profileMenu.profileMenuContent['_selector']);
    await profileMenu.validateUserProfileManuIsOpen();
    await profileMenu.validateUserNameInProfileMenu(user.username);
  });

  test('Sign In and Logout to the Denser App', async ({page}) =>{
    const loginFormDefaut = new LoginForm(page);
    const profileMenu = new ProfileUserMenu(page);

    await homePage.loginBtn.click()
    await loginFormDefaut.validateDefaultLoginFormIsLoaded();
    // Sign In
    await loginFormDefaut.usernameInput.fill(user.username);
    await loginFormDefaut.passwordInput.fill(user.password);
    await loginFormDefaut.wifInput.fill(user.keys[0].private); // Posting Key
    await loginFormDefaut.saveSignInButton.click();
    await homePage.profileAvatarButton.click();
    // Validate User is logged in
    await page.waitForSelector(profileMenu.profileMenuContent['_selector']);
    await profileMenu.validateUserProfileManuIsOpen();
    await profileMenu.validateUserNameInProfileMenu(user.username);
    // Logout
    await profileMenu.logoutLink.click();
    // Validate user is logged out
    await expect(homePage.profileAvatarButton).not.toBeVisible();
    await homePage.isTrendingCommunitiesVisible();
  });

  // --

  // Account name should not be empty.   - Wrong username
  // Account name should be longer. - Wrong username
  // Password length should be at least 6 characters - Wrong password
  // WIF should not be empty. - Wrong WIF (needs username)
  // Invalid WIF key. - Wrong WIF (needs username)
  // No WIF key from user - in the other sign in options form
  // Invalid WIF key. - in Enter your WIF key

});
