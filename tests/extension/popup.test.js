// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests for the extension popup.
 *
 * Opens the popup HTML directly as a page (not via the toolbar icon) so we
 * can inspect its DOM without the complexities of clicking the browser action.
 * The mock TTS server (started in global-setup.js) handles API calls.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from './helpers/extension-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('Popup UI', () => {
  let popupPage;

  test.beforeEach(async ({ extensionId, context }) => {
    // Open the popup as a regular page via its chrome-extension:// URL
    popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    // Allow popup scripts to finish initialization
    await popupPage.waitForTimeout(800);
  });

  test('renders the Lyra heading', async () => {
    const heading = popupPage.locator('h1');
    await expect(heading).toHaveText('Lyra');
  });

  test('shows Online badge when mock server is running', async () => {
    const badge = popupPage.locator('#status-badge');
    await expect(badge).toHaveText('Online', { timeout: 5000 });
  });

  test('voice select is populated from the server', async () => {
    const voiceSelect = popupPage.locator('#voice-select');
    const optionCount = await voiceSelect.locator('option').count();
    expect(optionCount).toBeGreaterThanOrEqual(2); // mock returns leo + tara
  });

  test('read-selection button is enabled after voices load', async () => {
    const btn = popupPage.locator('#btn-read-selection');
    await expect(btn).not.toBeDisabled({ timeout: 5000 });
  });

  test('read-page button is enabled after voices load', async () => {
    const btn = popupPage.locator('#btn-read-page');
    await expect(btn).not.toBeDisabled({ timeout: 5000 });
  });

  test('stop button is hidden by default', async () => {
    const btn = popupPage.locator('#btn-stop');
    await expect(btn).toBeHidden();
  });

  test('settings link is visible', async () => {
    const link = popupPage.locator('#options-link');
    await expect(link).toBeVisible();
  });
});

test.describe('Options page', () => {
  let optionsPage;

  test.beforeEach(async ({ extensionId, context, mockServerUrl }) => {
    optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
    await optionsPage.waitForTimeout(500);
    // Store mock URL for assertions
    optionsPage._mockServerUrl = mockServerUrl;
  });

  test('renders the settings heading', async () => {
    const heading = optionsPage.locator('h1');
    await expect(heading).toContainText('Settings');
  });

  test('server URL input has default value', async () => {
    // The fixture pre-seeds storage with the mock server URL, so that's what
    // the options page shows (rather than the hardcoded default 127.0.0.1:8000)
    const input = optionsPage.locator('#server-url');
    const value = await input.inputValue();
    expect(value).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('check connection button is visible', async () => {
    const btn = optionsPage.locator('#btn-check');
    await expect(btn).toBeVisible();
  });

  test('save button is visible', async () => {
    const btn = optionsPage.locator('#btn-save');
    await expect(btn).toBeVisible();
  });

  test('check connection reports Connected when mock server is running', async () => {
    await optionsPage.click('#btn-check');
    const status = optionsPage.locator('#server-status');
    await expect(status).toContainText('Connected', { timeout: 5000 });
  });
});
