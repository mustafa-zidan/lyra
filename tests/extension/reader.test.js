// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests for the reader view: opening it (through the background, as the
 * popup and shortcut do), text settings, sanitising, and reading/highlighting in it.
 */
import { test, expect } from './helpers/extension-context.js';

/** Open the options page (which seeds the server URL), then the fixture page in front. */
async function setUp(context, extensionId, mockServerUrl, settings = {}) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options/options.html`);
  await ext.waitForTimeout(300);
  if (Object.keys(settings).length) {
    await ext.evaluate((values) => chrome.storage.local.set(values), settings);
  }
  const page = await context.newPage();
  await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
  await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
  await page.bringToFront();
  const command = (name) =>
    ext.evaluate((command) => chrome.runtime.sendMessage({ action: 'command', command }), name);
  return { ext, page, command };
}

const cssVar = (page, name) =>
  page.evaluate(
    (name) => document.getElementById('lyra-reader-view')?.style.getPropertyValue(name),
    name,
  );

test.describe('Reader view', () => {
  test('opens with the article and closes with Escape', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page, command } = await setUp(context, extensionId, mockServerUrl);
    await command('reader-view');
    const article = page.locator('#lyra-reader-article');
    await expect(article).toContainText('Orpheus was a legendary musician');
    await expect(article.locator('h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('hidden');

    await page.keyboard.press('Escape');
    await expect(page.locator('#lyra-reader-view')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
  });

  test('the same command closes it again', async ({ context, extensionId, mockServerUrl }) => {
    const { page, command } = await setUp(context, extensionId, mockServerUrl);
    await command('reader-view');
    await expect(page.locator('#lyra-reader-view')).toBeVisible();
    await command('reader-view');
    await expect(page.locator('#lyra-reader-view')).toHaveCount(0);
  });

  test('text settings change the view and are saved', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { ext, page, command } = await setUp(context, extensionId, mockServerUrl);
    await command('reader-view');
    await expect(page.locator('#lyra-reader-view')).toBeVisible();
    expect(await cssVar(page, '--lr-font')).toContain('Lyra Atkinson Hyperlegible');

    await page.locator('#lyra-reader-text').click();
    const panel = page.locator('#lyra-reader-panel');
    await expect(panel).toBeVisible();
    await panel.locator('select').first().selectOption('opendyslexic');
    await panel.locator('select').nth(1).selectOption('dark');
    await panel.locator('input[type="range"]').first().fill('28');

    await expect.poll(() => cssVar(page, '--lr-font')).toContain('Lyra OpenDyslexic');
    expect(await cssVar(page, '--lr-bg')).toBe('#1c1c24');
    expect(await cssVar(page, '--lr-size')).toBe('28px');
    expect(
      await ext.evaluate(() =>
        chrome.storage.local.get(['readerFont', 'readerTheme', 'readerSize']),
      ),
    ).toEqual({ readerFont: 'opendyslexic', readerTheme: 'dark', readerSize: 28 });
  });

  test('the bundled fonts load in the page', async ({ context, extensionId, mockServerUrl }) => {
    const { page, command } = await setUp(context, extensionId, mockServerUrl, {
      readerFont: 'opendyslexic',
    });
    await command('reader-view');
    await expect(page.locator('#lyra-reader-view')).toBeVisible();
    const loaded = await page.evaluate(async () => {
      await document.fonts.load('20px "Lyra OpenDyslexic"');
      await document.fonts.load('20px "Lyra Atkinson Hyperlegible"');
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
    });
    expect(loaded.join()).toContain('Lyra OpenDyslexic');
    expect(loaded.join()).toContain('Lyra Atkinson Hyperlegible');
  });

  test('article HTML is rebuilt without scripts, handlers or styles', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page } = await setUp(context, extensionId, mockServerUrl);
    await page.evaluate(() => {
      window.__pwned = false;
    });
    const html = `<div onclick="window.__pwned=true" style="display:none"><p class="x" onmouseover="window.__pwned=true">Safe <b>bold</b> text<script>window.__pwned=true</script></p>
      <img src="x" onerror="window.__pwned=true"><a href="javascript:window.__pwned=true">bad link</a>
      <a href="https://example.com/ok">good link</a><iframe src="https://example.com"></iframe></div>`;
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await sw.evaluate(
      async ({ url, html }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.sendMessage(tab.id, {
          action: 'open-reader',
          text: 'Safe bold text',
          html,
          title: 'T',
        });
      },
      { url: `${mockServerUrl}/fixtures/test-page.html`, html },
    );
    const article = page.locator('#lyra-reader-article');
    await expect(article).toContainText('Safe bold text');
    expect(
      await article
        .locator('script, iframe, [onclick], [onmouseover], [style], [class="x"]')
        .count(),
    ).toBe(0);
    // The image stays, with only a resolved src and its alt: onerror is gone.
    expect(
      await article.locator('img').evaluateAll((is) => is.map((i) => i.getAttributeNames())),
    ).toEqual([['src', 'alt']]);
    const hrefs = await article
      .locator('a')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual([null, 'https://example.com/ok']);
    expect(await page.evaluate(() => window.__pwned)).toBe(false);
  });

  test('reading highlights words inside the view', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page } = await setUp(context, extensionId, mockServerUrl);
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const url = `${mockServerUrl}/fixtures/test-page.html`;
    // The highlight registry belongs to the content script's world: read it from there.
    const highlight = (name) =>
      sw.evaluate(
        async ({ url, name }) => {
          const [tab] = await chrome.tabs.query({ url });
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [name],
            func: (name) => {
              const hl = CSS.highlights.get(name);
              const range = hl ? [...hl][0] : null;
              if (!range) return null;
              const el = range.startContainer.parentElement;
              return {
                text: range.toString(),
                inReader: !!el?.closest('#lyra-reader-article'),
              };
            },
          });
          return result;
        },
        { url, name },
      );

    await sw.evaluate(
      async ({ url }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.sendMessage(tab.id, {
          action: 'open-reader',
          text: 'Orpheus sang to the trees [3s].',
          title: 'Song',
        });
      },
      { url },
    );
    await page.locator('#lyra-reader-read').click();
    await expect.poll(() => highlight('lyra-word'), { timeout: 10_000 }).not.toBeNull();
    const word = await highlight('lyra-word');
    expect(word.inReader).toBe(true);
    // Highlighted in the view, not in the page's own text underneath.
    expect((await highlight('lyra-reading')).inReader).toBe(true);

    await page.keyboard.press('Escape'); // closing stops the read and clears highlights
    await expect.poll(() => highlight('lyra-reading')).toBeNull();
    await expect(page.locator('#__lyra-status')).toHaveCSS('opacity', '0');
  });
});
