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
