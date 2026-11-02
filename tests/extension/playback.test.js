// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests for pausing, resuming and skipping a read, from the status bar and
 * from messages (as the popup and keyboard shortcuts send them).
 */
import { test, expect } from './helpers/extension-context.js';

const CHUNKS = [
  'Orpheus took up his lyre [1.5s].',
  'He walked down into the underworld [3s].',
  'Hades listened and wept [1.5s].',
  'Eurydice followed him toward the light [1.5s].',
];

async function serviceWorker(context) {
  const [sw] = context.serviceWorkers();
  return sw ?? (await context.waitForEvent('serviceworker', { timeout: 10_000 }));
}

/** Open the playback fixture and start reading `chunks` in it. */
async function startRead(context, mockServerUrl, chunks = CHUNKS) {
  const url = `${mockServerUrl}/fixtures/playback-page.html`;
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
  // A click in the page lets its AudioContext start without a suspended state.
  await page.mouse.click(5, 5);
  const sw = await serviceWorker(context);

  const send = (message) =>
    sw.evaluate(
      async ({ url, message }) => {
        const [tab] = await chrome.tabs.query({ url });
        return chrome.tabs.sendMessage(tab.id, message);
      },
      { url, message },
    );

  /** Text of a highlight (the chunk/sentence by default, or 'lyra-word'), or null. */
  const highlighted = (name = 'lyra-reading') =>
    sw.evaluate(
      async ({ url, name }) => {
        const [tab] = await chrome.tabs.query({ url });
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [name],
          func: (name) => {
            const hl = CSS.highlights.get(name);
            const range = hl ? [...hl][0] : null;
            return range ? range.toString().trim() : null;
          },
        });
        return result;
      },
      { url, name },
    );

  await send({
    action: 'start-reading',
    readId: `test-${Date.now()}`,
    chunks,
    voice: 'af_heart',
    serverUrl: mockServerUrl,
    model: 'mlx-community/Kokoro-82M-bf16',
  });
  await expect.poll(highlighted, { timeout: 10_000 }).toMatch(/\S/);
  return { page, send, highlighted };
}

test.describe('Playback controls', () => {
  test('first chunk is highlighted', async ({ context, mockServerUrl }) => {
    const { highlighted } = await startRead(context, mockServerUrl);
    expect(await highlighted()).toBe(CHUNKS[0]);
  });

  test('the status bar pauses and resumes the read', async ({ context, mockServerUrl }) => {
    const { page, send, highlighted } = await startRead(context, mockServerUrl);
    const pause = page.locator('#__lyra-pause');
    await expect(pause).toHaveAttribute('aria-label', 'Pause');
    await pause.click();
    await expect(pause).toHaveAttribute('aria-label', 'Resume');
    expect(await send({ action: 'get-state' })).toEqual({ reading: true, paused: true });

    // Paused: the first chunk (1.5 s) doesn't finish.
    await page.waitForTimeout(2500);
    expect(await highlighted()).toBe(CHUNKS[0]);

    await pause.click();
    expect(await send({ action: 'get-state' })).toEqual({ reading: true, paused: false });
    await expect.poll(highlighted, { timeout: 5000 }).toBe(CHUNKS[1]);
  });

  test('forward skips to the next passage at once', async ({ context, mockServerUrl }) => {
    const { page, highlighted } = await startRead(context, mockServerUrl);
    await page.locator('#__lyra-forward').click();
    await expect.poll(highlighted, { timeout: 1000 }).toBe(CHUNKS[1]);
    await page.locator('#__lyra-forward').click();
    await expect.poll(highlighted, { timeout: 1000 }).toBe(CHUNKS[2]);
  });

  test('back goes to the previous passage, or restarts a long-playing one', async ({
    context,
    mockServerUrl,
  }) => {
    const { page, send, highlighted } = await startRead(context, mockServerUrl);
    await send({ action: 'playback-control', command: 'forward' });
    await expect.poll(highlighted, { timeout: 1000 }).toBe(CHUNKS[1]);

    // Right after it starts, back goes to the passage before.
    await send({ action: 'playback-control', command: 'back' });
    await expect.poll(highlighted, { timeout: 1000 }).toBe(CHUNKS[0]);

    // Two seconds into the 3 s passage, back hears it again from the start.
    await send({ action: 'playback-control', command: 'forward' });
    await expect.poll(highlighted, { timeout: 1000 }).toBe(CHUNKS[1]);
    await page.waitForTimeout(2300);
    await send({ action: 'playback-control', command: 'back' });
    await page.waitForTimeout(1200); // past where the passage would have ended
    expect(await highlighted()).toBe(CHUNKS[1]);
  });

  test('forward from the last passage ends the read', async ({ context, mockServerUrl }) => {
    const { page, send } = await startRead(context, mockServerUrl);
    for (let i = 0; i < CHUNKS.length; i++) {
      await send({ action: 'playback-control', command: 'forward' });
      await page.waitForTimeout(150);
    }
    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 5000 });
    await expect(page.locator('#__lyra-controls')).toBeHidden();
    expect(await send({ action: 'get-state' })).toEqual({ reading: false, paused: false });
  });

  test("the background's control message pauses the reading tab", async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page, send } = await startRead(context, mockServerUrl);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    // The popup opened as a tab is its own active tab, so it can't show this read's
    // controls; send what its Pause button sends and check the reading tab.
    await popup.evaluate(() =>
      chrome.runtime.sendMessage({ action: 'command', command: 'toggle-pause' }),
    );
    await expect
      .poll(() => send({ action: 'get-state' }))
      .toEqual({
        reading: true,
        paused: true,
      });
    await expect(page.locator('#__lyra-pause')).toHaveAttribute('aria-label', 'Resume');
  });
});

test.describe('Word-by-word highlight', () => {
  // The mock spreads the 4 s evenly over the chunk's 13 words (marker included).
  const CHUNK = 'Orpheus sang to the trees. The stones wept with him [4s].';

  test('the spoken word and its sentence follow the audio', async ({ context, mockServerUrl }) => {
    const { highlighted } = await startRead(context, mockServerUrl, [CHUNK]);
    await expect.poll(() => highlighted('lyra-word'), { timeout: 2000 }).toBe('Orpheus');
    // The page has a footnote marker the chunk doesn't; the sentence still lines up.
    await expect.poll(() => highlighted(), { timeout: 2000 }).toBe('Orpheus sang1 to the trees.');
    // Each word lasts ~0.3 s, too short to catch reliably: wait for any word of the
    // second sentence, then check the sentence highlight moved with it.
    await expect
      .poll(() => highlighted('lyra-word'), { timeout: 3000 })
      .toMatch(/^(The|stones|wept|with|him)$/);
    expect(await highlighted()).toBe('The stones wept with him [4s].');
  });

  test('turning it off keeps the whole chunk highlighted', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/options/options.html`);
    await ext.evaluate(() => chrome.storage.local.set({ wordHighlight: false }));
    await ext.close();
    const { page, highlighted } = await startRead(context, mockServerUrl, [CHUNK]);
    await page.waitForTimeout(2600);
    expect(await highlighted('lyra-word')).toBeNull();
    expect(await highlighted()).toBe('Orpheus sang1 to the trees. The stones wept with him [4s].');
  });
});
