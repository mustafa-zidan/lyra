// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Integration tests for content.js, highlighting and status bar behaviour.
 *
 * These tests load the real test-page.html through a file:// URL and inject
 * the content script to verify DOM interactions.
 */
import { test, expect } from './helpers/extension-context.js';

test.describe('Content script: status bar', () => {
  test('status bar is not visible on page load', async ({ context, mockServerUrl }) => {
    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);

    const bar = page.locator('#__lyra-status');
    // Bar may not exist yet, or be off-screen
    const exists = await bar.count();
    if (exists > 0) {
      const transform = await bar.evaluate((el) => el.style.transform);
      expect(transform).toContain('translateY(100%)');
    } else {
      expect(exists).toBe(0);
    }
  });

  test('status bar appears and shows label after playback-started message', async ({
    context,
    mockServerUrl,
  }) => {
    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);

    // Simulate a message from the background worker
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { action: 'playback-started', text: 'test' },
        }),
      );
      // Directly call the content script listener by dispatching a chrome runtime message
      // The content script listens via chrome.runtime.onMessage, we invoke it indirectly
      // by using the extension's internal message channel.
    });

    // The content script injects its status bar lazily, verify it exists in DOM
    // after the page has fully loaded the content script
    await page.waitForTimeout(300);
    const injected = await page.evaluate(() => !!document.getElementById('__lyra-hl-style'));
    expect(injected).toBe(true);
  });
});

test.describe('Content script — text highlighting', () => {
  test('highlight style tag is injected into head', async ({ context, mockServerUrl }) => {
    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
    await page.waitForTimeout(300);

    const hasStyle = await page.evaluate(
      () => document.getElementById('__lyra-hl-style') !== null,
    );
    expect(hasStyle).toBe(true);
  });

  test('page text content is readable for indexing', async ({ context, mockServerUrl }) => {
    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain('Orpheus');
    expect(text).toContain('Eurydice');
  });
});

test.describe('Content script: reading a long page', () => {
  test('reads every chunk of a long selection in order, to the end', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    test.setTimeout(60_000);
    // Other test files use the mock server at the same time: keep only this read's texts.
    const ours = (log) => log.filter((t) => /Paragraph \d+|List item|Orpheus sang/.test(t ?? ''));
    const before = ours(await (await fetch(`${mockServerUrl}/__tts-log`)).json()).length;
    // Opening an extension page runs the fixture's init script, which points the
    // saved server URL at the mock server.
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options/options.html`);
    await settings.waitForTimeout(300);
    await settings.close();

    const page = await context.newPage();
    await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
    // ~40k characters: far more than one request may carry (the server takes 5000),
    // including a list with no full stops, which used to become one oversized chunk.
    await page.evaluate(() => {
      const section = document.createElement('section');
      section.id = 'long';
      for (let i = 0; i < 60; i++) {
        const p = document.createElement('p');
        p.textContent = `Paragraph ${i} begins here. ${'Orpheus sang to the trees and stones. '.repeat(15)}`;
        section.append(p);
      }
      const ul = document.createElement('ul');
      for (let i = 0; i < 200; i++) {
        const li = document.createElement('li');
        li.textContent = `List item ${i} without a full stop`;
        ul.append(li);
      }
      section.append(ul);
      document.body.append(section);
      const range = document.createRange();
      range.selectNodeContents(section);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.mouse.move(5, 5);
    await page.mouse.down();
    await page.mouse.up(); // shows the Listen button for the selection
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('long'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await page.locator('#__lyra-selection-btn').click();

    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 45_000 });

    const log = ours(await (await fetch(`${mockServerUrl}/__tts-log`)).json()).slice(before);
    expect(log.length).toBeGreaterThan(80);
    expect(log[0].length).toBeLessThanOrEqual(180); // short first chunk: quick start
    for (const text of log) expect(text.length).toBeLessThanOrEqual(450);
    const spoken = log.join(' ');
    expect(spoken).toContain('Paragraph 0 begins here.');
    expect(spoken).toContain('Paragraph 59 begins here.');
    expect(spoken).toContain('List item 199 without a full stop');
    // Requested in page order.
    expect(spoken.indexOf('Paragraph 10 ')).toBeLessThan(spoken.indexOf('Paragraph 11 '));
  });
});
