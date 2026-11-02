// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests for reading-position highlighting in content.js.
 *
 * Messages are sent to the page's content script from the extension's service worker,
 * exactly as a real read does, and the resulting highlight is read back through
 * chrome.scripting in the extension's isolated world.
 */
import { test, expect } from './helpers/extension-context.js';

/** The extension's service worker, waiting for it to start if needed. */
async function serviceWorker(context) {
  const [sw] = context.serviceWorkers();
  return sw ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
}

/** Open the fixture page and return a helper that drives a read in it. */
async function openReader(context, mockServerUrl) {
  const url = `${mockServerUrl}/fixtures/highlight-page.html`;
  const page = await context.newPage();
  await page.goto(url);
  // The content script runs at document_idle; wait for its style tag to be injected.
  await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
  const sw = await serviceWorker(context);

  const send = (message) =>
    sw.evaluate(
      async ({ url, message }) => {
        const [tab] = await chrome.tabs.query({ url });
        await chrome.tabs.sendMessage(tab.id, message);
      },
      { url, message },
    );

  /** The highlighted text and the id of the element it starts in, or null. */
  const highlighted = () =>
    sw.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const hl = CSS.highlights.get('lyra-reading');
          const range = hl ? [...hl][0] : null;
          if (!range) return null;
          return {
            text: range.toString().replace(/\s+/g, ' ').trim(),
            id: range.startContainer.parentElement.closest('[id]')?.id ?? null,
          };
        },
      });
      return result;
    }, url);

  return { page, send, highlighted };
}

test.describe('Content script: reading highlight', () => {
  test('highlights a chunk whose page text has extra whitespace', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'Orpheus played the lyre.' });

    expect(await highlighted()).toEqual({ text: 'Orpheus played the lyre.', id: 'intro' });
  });

  test('highlights a chunk that spans inline elements', async ({ context, mockServerUrl }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({
      action: 'chunk-highlight',
      text: 'He played it on the Argo, and the Sirens fell silent.',
    });

    const hl = await highlighted();
    expect(hl?.text).toBe('He played it on the Argo, and the Sirens fell silent.');
    expect(hl?.id).toBe('body');
  });

  test('a repeated sentence highlights the copy after the previous chunk', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });

    // "Read more." is first on the page in the nav, but reading has reached the intro.
    await send({ action: 'chunk-highlight', text: 'Orpheus played the lyre.' });
    await send({ action: 'chunk-highlight', text: 'Read more.' });
    expect(await highlighted()).toEqual({ text: 'Read more.', id: 'intro' });

    // And the next copy after that is the last paragraph, not the intro again.
    await send({ action: 'chunk-highlight', text: 'The lyre of Orpheus was a gift from Apollo.' });
    expect((await highlighted())?.id).toBe('body');
    await send({ action: 'chunk-highlight', text: 'Read more.' });
    expect(await highlighted()).toEqual({ text: 'Read more.', id: 'outro' });
  });

  test('a new read starts matching from the top of the page again', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'The lyre of Orpheus was a gift from Apollo.' });

    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'Read more.' });
    expect((await highlighted())?.id).toBe('nav');
  });

  test('a chunk not on the page clears the highlight', async ({ context, mockServerUrl }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'Orpheus played the lyre.' });
    await send({ action: 'chunk-highlight', text: 'Eurydice is not on this page.' });

    expect(await highlighted()).toBeNull();
  });

  test('a chunk without the page footnote marker still highlights', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'Eurydice was bitten by a viper and died.' });

    expect(await highlighted()).toEqual({
      text: 'Eurydice was bitten by a viper[1] and died.',
      id: 'footnote',
    });
  });

  test('straight quotes and dashes match smart ones on the page', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({
      action: 'chunk-highlight',
      text: '"Don\'t look back," Hades said - and Orpheus did.',
    });

    expect(await highlighted()).toEqual({
      text: '“Don’t look back,” Hades said — and Orpheus did.',
      id: 'quotes',
    });
  });

  test('a chunk missing hidden page text still highlights', async ({ context, mockServerUrl }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'The gates of the underworld opened.' });

    expect((await highlighted())?.id).toBe('hidden');
  });

  test('chunks cut mid-word highlight the whole word on both sides', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: '"Don\'t look back," Hades sa' });
    expect(await highlighted()).toEqual({ text: '“Don’t look back,” Hades said', id: 'quotes' });

    await send({ action: 'chunk-highlight', text: 'id - and Orpheus did.' });
    expect(await highlighted()).toEqual({ text: 'said — and Orpheus did.', id: 'quotes' });
  });

  test('fuzzy matching works on Japanese text without spaces', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    // Readability dropped a character; there are no spaces to split words on.
    await send({ action: 'chunk-highlight', text: 'オルフェウスは竪琴を弾た。' });

    expect(await highlighted()).toEqual({ text: 'オルフェウスは竪琴を弾いた。', id: 'cjk' });
  });

  test('a chunk sharing only a few words with the page is not highlighted', async ({
    context,
    mockServerUrl,
  }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({
      action: 'chunk-highlight',
      text: 'Orpheus played a song that nobody in the hall had heard before.',
    });

    expect(await highlighted()).toBeNull();
  });

  test('null text clears the highlight', async ({ context, mockServerUrl }) => {
    const { send, highlighted } = await openReader(context, mockServerUrl);
    await send({ action: 'playback-started', text: '' });
    await send({ action: 'chunk-highlight', text: 'Orpheus played the lyre.' });
    await send({ action: 'chunk-highlight', text: null });

    expect(await highlighted()).toBeNull();
  });
});
