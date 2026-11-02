// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests for reading settings and playback controls, driven through the
 * real extension against the mock TTS server.
 */
import { test, expect } from './helpers/extension-context.js';

/**
 * Open an extension page (which points the saved server URL at the mock server, see the
 * fixture's init script), optionally change settings there, and close it.
 */
async function prepareSettings(context, extensionId, settings = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForTimeout(300);
  if (Object.keys(settings).length) {
    await page.evaluate((values) => chrome.storage.local.set(values), settings);
  }
  await page.close();
}

/** Open the fixture page, select a paragraph and click the Listen button. */
async function readParagraph(context, mockServerUrl, selector = 'p') {
  const page = await context.newPage();
  await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
  await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
  await page.evaluate((sel) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(sel));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  }, selector);
  await page.locator('#__lyra-selection-btn').click();
  return page;
}

/** Poll the page's injected highlight stylesheet (a <style> has no rendered text). */
function expectStyle(page) {
  return expect.poll(() =>
    page.evaluate(() => document.getElementById('__lyra-hl-style')?.textContent ?? ''),
  );
}

/**
 * Requests for the fixture's first paragraph (what readParagraph reads). Other test files
 * use the mock server at the same time, so their requests are filtered out.
 */
async function ttsRequests(mockServerUrl) {
  const all = await (await fetch(`${mockServerUrl}/__tts-requests`)).json();
  return all.filter((body) => body?.text?.includes('legendary musician'));
}

test.describe('Reading speed', () => {
  test.beforeEach(async ({ mockServerUrl }) => {
    await fetch(`${mockServerUrl}/__tts-requests`, { method: 'DELETE' });
  });

  test('the popup speed slider is saved and sent with each chunk', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    await prepareSettings(context, extensionId);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.locator('#speed').fill('0.8');
    await expect(popup.locator('#speed-value')).toHaveText('0.8×');
    await popup.close();

    const page = await readParagraph(context, mockServerUrl);
    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 15_000 });
    const requests = await ttsRequests(mockServerUrl);
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests) expect(body.speed).toBe(0.8);
  });

  test('normal speed is left out of the request', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    await prepareSettings(context, extensionId, { speed: 1 });
    const page = await readParagraph(context, mockServerUrl);
    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 15_000 });
    const requests = await ttsRequests(mockServerUrl);
    expect(requests.length).toBeGreaterThan(0);
    for (const body of requests) expect(body).not.toHaveProperty('speed');
  });
});

test.describe('Highlight colour and style', () => {
  test('a preset chosen in the options page is saved', async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.locator('input[aria-label="Yellow"]').check();
    await options.locator('#highlight-style').selectOption('both');
    await options.locator('#btn-save').click();
    await expect(options.locator('#save-msg')).toHaveText('Settings saved!');
    const saved = await options.evaluate(() =>
      chrome.storage.local.get(['highlightColor', 'highlightStyle', 'highContrast']),
    );
    expect(saved).toEqual({
      highlightColor: '#fff3a3',
      highlightStyle: 'both',
      highContrast: false,
    });
  });

  test('pages restyle the highlight when the settings change', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
    await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
    const style = expectStyle(page);
    await style.toContain('background-color: #dcd7fc');

    await prepareSettings(context, extensionId, {
      highlightColor: '#c8f2c2',
      highlightStyle: 'underline',
    });
    await style.toContain('text-decoration: underline');
    await style.toContain('#c8f2c2');
    await style.not.toContain('background-color: #c8f2c2');

    await prepareSettings(context, extensionId, { highContrast: true });
    await style.toContain('background-color: #1b1b2a; color: #ffffff');
  });

  test('only #rrggbb colours reach the page stylesheet', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
    await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
    await prepareSettings(context, extensionId, { highlightColor: 'red; } body { display: none' });
    await page.waitForTimeout(300);
    await expectStyle(page).toContain('background-color: #dcd7fc');
    await expectStyle(page).not.toContain('display: none');
  });
});
