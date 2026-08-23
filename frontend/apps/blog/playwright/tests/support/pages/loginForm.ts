import { Locator, Page, expect } from '@playwright/test';

export class LoginForm {
  readonly page: Page;
  readonly loginDialog: Locator;
  readonly keychainRow: Locator;
  readonly googleSigninRow: Locator;
  readonly loginFormHeader: Locator;
  readonly loginFormDescription: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly wifInput: Locator;
  readonly saveSignInButton: Locator;
  readonly signInButton: Locator;
  readonly otherSignInOptionsButton: Locator;
  readonly otherSignInOptionsHeader: Locator;
  readonly otherSignInOptionsDescription: Locator;
  readonly otherSignInOptionsErrorMessage: Locator;
  readonly otherSignInOptionsUsernameInput: Locator;
  readonly otherSignInOptionsUsernameErrorMsg: Locator;
  readonly hiveKeychainExtensionButton: Locator;
  readonly signInWithWifButton: Locator;
  readonly hiveAuthButton: Locator;
  readonly hiveSignerButton: Locator;
  readonly goBackButton: Locator;
  readonly closeDialog: Locator;

  readonly headerEnterYourWifKey: Locator;
  readonly postingPrivateKeyInput: Locator;
  readonly storeKeyCheckbox: Locator;
  readonly postingPrivateKeySubmitButton: Locator;
  readonly postingPrivateKeyResetButton: Locator;

  readonly usernameErrorMessage: Locator;
  readonly passwordErrorMessage: Locator;
  readonly wifInputErrorMessage: Locator;
  readonly passwordErrorMessageEnterYourWifKey: Locator;

  readonly enterYourPasswordForm: Locator;
  readonly headerEnterYourPassword: Locator;
  readonly passwordToUnlockKeyInput: Locator;
  readonly passwordToUnlockKeySubmitButton: Locator;
  readonly passwordToUnlockKeyResetButton: Locator;

  readonly errorToastContent: Locator;
  readonly errorToastContentTrigger: Locator;
  readonly errorToastContentMessage: Locator;

  readonly biometricPromptNotNowButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.loginDialog = page.getByTestId('login-dialog');
    // ★ Lumen's sign-in dialog (2026-08-21): Keychain and Google are the only two
    // methods it offers. `features/lite-auth/login/lumen-login.tsx`, rendered by
    // `components/dialog-login.tsx`.
    this.keychainRow = page.getByTestId('keychain-row');
    this.googleSigninRow = page.getByTestId('google-signin-row');
    this.loginFormHeader = page.getByText('Sign in with safe storage');
    this.loginFormDescription = page.getByTestId('login-form-description');
    this.usernameInput = page.getByTestId('username-input');
    this.passwordInput = page.getByTestId('password-input');
    this.wifInput = page.getByTestId('wif-input');
    this.saveSignInButton = page.getByTestId('save-sign-in-button');
    this.signInButton = page.locator('[type="submit"]');
    this.otherSignInOptionsButton = page.getByTestId('other-sign-in-options-button');
    this.closeDialog = page.getByTestId('close-dialog');

    this.otherSignInOptionsHeader = page.getByText('Other sign in options');
    this.otherSignInOptionsDescription = page.getByTestId('other-signin-options-description');
    this.otherSignInOptionsErrorMessage = page.getByTestId('other-signin-options-error-msg');
    this.otherSignInOptionsUsernameInput = page.getByTestId('other-signin-options-username-input');
    this.otherSignInOptionsUsernameErrorMsg = page.getByTestId('other-signin-username-error-msg');
    this.hiveKeychainExtensionButton = page.getByTestId('hive-keychain-extension-button');
    this.signInWithWifButton = page.getByTestId('sign-in-with-wif-button');
    this.hiveAuthButton = page.getByTestId('hive-auth-button');
    this.hiveSignerButton = page.getByTestId('hive-signer-button');
    this.goBackButton = page.getByTestId('go-back-button');

    this.headerEnterYourWifKey = page.getByText('Enter your WIF key');
    this.postingPrivateKeyInput = page.getByTestId('posting-private-key-input');
    this.storeKeyCheckbox = page.getByLabel('Store key');
    this.postingPrivateKeySubmitButton = page.getByTestId('password-submit-button');
    this.postingPrivateKeyResetButton = page.getByTestId('password-reset-button');

    this.usernameErrorMessage = page.getByTestId('username-error-message');
    this.passwordErrorMessage = page.getByTestId('password-error-message');
    this.wifInputErrorMessage = page.getByTestId('wif-input-error-message');
    this.passwordErrorMessageEnterYourWifKey = page.getByTestId('password-form-error-message');

    this.enterYourPasswordForm = page.getByTestId('enter-password-to-unlock-key');
    this.headerEnterYourPassword = page.getByText('Enter your password');
    this.passwordToUnlockKeyInput = page.getByTestId('posting-private-key-input');
    this.passwordToUnlockKeySubmitButton = page.getByTestId('password-submit-button');
    this.passwordToUnlockKeyResetButton = page.getByTestId('password-reset-button');

    this.errorToastContent = page.getByTestId('error-toast-content');
    this.errorToastContentTrigger = page.getByTestId('error-toast-content-trigger');
    this.errorToastContentMessage = page.getByTestId('error-toast-content-message');

    this.biometricPromptNotNowButton = this.loginDialog.getByRole('button', { name: 'Not now' });
  }

  // After a successful Safe storage sign-in, the app may show an
  // "Enable biometric unlock?" prompt that blocks finalize() until dismissed.
  // Click "Not now" if it appears so the login flow can complete.
  async dismissBiometricPromptIfPresent() {
    try {
      await this.biometricPromptNotNowButton.waitFor({ state: 'visible', timeout: 3000 });
      await this.biometricPromptNotNowButton.click();
    } catch {
      // Prompt not shown — nothing to dismiss.
    }
  }

  /*
   * ★★★ REWRITTEN FOR LUMEN'S SIGN-IN DIALOG (2026-08-21).
   *
   * This used to assert the denser safe-storage form: a description reading "Save
   * your posting key by filling form below", plus Username / Safe storage password
   * / WIF placeholders and a Save-sign-in button. Every one of those is gone —
   * `packages/smart-signer/components/auth/methods/safestorage.tsx` and its
   * siblings have ZERO imports anywhere in `apps/blog`.
   *
   * This method is the single highest-leverage locator in the suite: 20 call sites
   * across 6 spec files, almost all of them "click something while signed out and
   * check the login surface appears". One dead testid here failed all of them.
   *
   * Measured live by clicking a comment upvote while signed out: a `role="dialog"`
   * opens, headed "Sign In", containing exactly `keychain-row`, `google-signin-row`
   * and `close-dialog`. The assertions below check that surface, at the same
   * strength as before (six assertions, none conditional).
   */
  /**
   * Signing in is a PAGE at /login, not a modal. The header control is a link
   * (`login-link` carries href="/login") and clicking it navigates, so there is no
   * dialog to wait for and `getByRole('dialog')` can only ever time out here.
   *
   * The page offers exactly two ways in: the Keychain row and the Google row.
   * There is no WIF/posting-key form to assert -- keychain-signin.tsx states
   * Keychain is the only Hive-key path Lumen offers -- so an assertion on the
   * text "posting key" fails against the real page.
   *
   * A login DIALOG does still exist (components/dialog-login.tsx) but it is
   * mounted on the post page for logged-out reply and vote, not on this route.
   * Assert it from a post-page test, not from here.
   */
  async validateDefaultLoginFormIsLoaded() {
    await expect(this.page).toHaveURL(/\/login(?:[?#]|$)/);
    await expect(this.keychainRow).toBeVisible();
    await expect(this.googleSigninRow).toBeVisible();
  }

  async validateUnlockUserWithPasswordLoginFormIsLoaded(username: string) {
    await this.page.waitForSelector(this.loginFormDescription['_selector']);
    await expect(this.loginFormDescription).toHaveText('Unlock user with password');
    await expect(this.usernameInput).toHaveAttribute('value', username);
    await expect(this.passwordInput).toHaveAttribute('placeholder', 'Safe storage password');
    await expect(this.signInButton).toBeDisabled();
    await expect(this.otherSignInOptionsButton).toBeVisible();
  }

  async validateDefaultOtherSignInOptionsFormIsLoaded() {
    await this.page.waitForSelector(this.otherSignInOptionsDescription['_selector']);
    await expect(this.otherSignInOptionsDescription).toHaveText(
      'Enter your username and select a sign in method'
    );
    await expect(this.otherSignInOptionsUsernameInput).toHaveAttribute('placeholder', 'Username');
    await expect(this.hiveKeychainExtensionButton).toBeDisabled();
    await expect(this.signInWithWifButton).toBeDisabled();
    await expect(this.hiveAuthButton).toBeDisabled();
    await expect(this.hiveSignerButton).toBeDisabled();
    await expect(this.goBackButton).toBeEnabled();
  }

  // user when username is typed in Sign in form
  async validateOtherSignInOptionsFormWithUsernameIsLoaded(username: string) {
    await this.page.waitForSelector(this.otherSignInOptionsDescription['_selector']);
    await expect(this.otherSignInOptionsDescription).toHaveText(
      'Enter your username and select a sign in method'
    );
    await expect(this.otherSignInOptionsUsernameInput).toHaveAttribute('value', username);
    // Note: Keychain/MetaMask/PeakVault/Google buttons are only enabled if browser extensions
    // or required configuration (e.g., GOOGLE_DRIVE_CLIENT_ID) are available.
    // On CI (headless), these will typically be disabled. Locally with extensions, they may be enabled.
    // We only assert that WIF is always enabled (no extension/config required)
    await expect(this.signInWithWifButton).toBeEnabled();
    await expect(this.hiveAuthButton).toBeDisabled();
    await expect(this.hiveSignerButton).toBeDisabled();
    await expect(this.goBackButton).toBeEnabled();
  }

  async validateEnterYourWifKeyFormIsLoaded() {
    await this.page.waitForSelector(this.headerEnterYourWifKey['_selector']);
    await expect(this.headerEnterYourWifKey).toBeVisible();
    await expect(this.postingPrivateKeyInput).toBeVisible();
    await expect(this.storeKeyCheckbox).not.toBeChecked();
    await expect(this.postingPrivateKeySubmitButton).toBeVisible();
    await expect(this.postingPrivateKeyResetButton).toBeVisible();
  }

  async validateEnterYourPasswordToUnlockKeyIsLoaded() {
    await this.page.waitForSelector(this.enterYourPasswordForm['_selector']);
    await expect(this.headerEnterYourPassword).toHaveText('Enter your password');
    await expect(this.passwordToUnlockKeyInput).toHaveAttribute('placeholder', 'Password to unlock key');
    await expect(this.passwordToUnlockKeySubmitButton).toBeVisible();
    await expect(this.passwordToUnlockKeyResetButton).toBeVisible();
  }

  async putEnterYourPasswordToUnlockKey(safeStoragePassword: string) {
    await this.page.waitForSelector(this.enterYourPasswordForm['_selector']);
    await expect(this.headerEnterYourPassword).toHaveText('Enter your password');
    await expect(this.passwordToUnlockKeyInput).toHaveAttribute('placeholder', 'Password to unlock key');
    await expect(this.passwordToUnlockKeySubmitButton).toBeVisible();
    await expect(this.passwordToUnlockKeyResetButton).toBeVisible();
    await this.passwordToUnlockKeyInput.fill(safeStoragePassword);
    await this.passwordToUnlockKeySubmitButton.click();
  }

  async putEnterYourPasswordToUnlockKeyIfNeeded(safeStoragePassword: string) {
    if (await this.enterYourPasswordForm.isVisible()) {
      await this.putEnterYourPasswordToUnlockKey(safeStoragePassword);
    }
  }

  async closeLoginForm() {
    await this.closeDialog.click();
  }
}
