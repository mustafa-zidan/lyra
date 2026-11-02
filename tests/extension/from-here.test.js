// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "Read from here": Alt+click a paragraph, or the context-menu item, reads from that
 * block to the end of the article.
 */
import { test, expect } from './helpers/extension-context.js';

const PAGE = '/fixtures/from-here-page.html';

async function serviceWorker(context) {
  const [sw] = context.serviceWorkers();
  return sw ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
}

async function openPage(context, extensionId, mockServerUrl, settings = {}) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options/options.html`);
  await ext.waitForTimeout(300);
  await ext.evaluate((values) => chrome.storage.local.set(values), {
    clickToRead: true,
    ...settings,
  });
  await ext.close();
  const page = await context.newPage();
  await page.goto(`${mockServerUrl}${PAGE}`);
  await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
  return page;
}

/**
 * Texts sent to the server for this fixture. Other test files share the mock server
 * (and its log) at the same time, so filter by the fixture's words, and pass the count
 * from before an action to get only what it sent.
 */
async function fixtureLog(mockServerUrl) {
  const log = await (await fetch(`${mockServerUrl}/__tts-log`)).json();
  return log.filter((t) => /Thrace|Calliope|wolves|newsletter/.test(t ?? ''));
}

async function spokenSince(mockServerUrl, before) {
  return (await fixtureLog(mockServerUrl)).slice(before).join(' ');
}

test.describe('Read from here', () => {
  test.describe.configure({ mode: 'serial' });

  test('Alt+click reads from the paragraph to the end of the article', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const before = (await fixtureLog(mockServerUrl)).length;
    const page = await openPage(context, extensionId, mockServerUrl);
    await page.locator('#second').click({ modifiers: ['Alt'] });
    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 15_000 });

    const text = await spokenSince(mockServerUrl, before);
    expect(text).toMatch(/^Calliope's son grew up/);
    expect(text).toContain('or so the stories of the region claim.');
    expect(text).not.toContain('kingdom of Thrace'); // before the clicked block
    expect(text).not.toContain('newsletter'); // outside the article
  });

  test('Alt+click on a link is left alone', async ({ context, extensionId, mockServerUrl }) => {
    const before = (await fixtureLog(mockServerUrl)).length;
    const page = await openPage(context, extensionId, mockServerUrl);
    await page.locator('#inline-link').click({ modifiers: ['Alt'] });
    await page.waitForTimeout(800);
    expect(await spokenSince(mockServerUrl, before)).toBe('');
  });

  test('Alt+click does nothing when turned off', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const before = (await fixtureLog(mockServerUrl)).length;
    const page = await openPage(context, extensionId, mockServerUrl, { clickToRead: false });
    await page.locator('#second').click({ modifiers: ['Alt'] });
    await page.waitForTimeout(800);
    expect(await spokenSince(mockServerUrl, before)).toBe('');
  });

  test('the context menu target gives the text from that block on', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const page = await openPage(context, extensionId, mockServerUrl);
    await page.locator('#third').click({ button: 'right' });
    await page.keyboard.press('Escape'); // close the native menu
    const sw = await serviceWorker(context);
    const here = await sw.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab.id, { action: 'get-text-from-here' });
    }, `${mockServerUrl}${PAGE}`);
    expect(here.anchor).toMatch(/^In time his playing could calm wolves/);
    expect(here.text).toMatch(/^In time his playing/);
    expect(here.text).not.toContain('Calliope');
    expect(here.language).toBe('en');
  });
});
