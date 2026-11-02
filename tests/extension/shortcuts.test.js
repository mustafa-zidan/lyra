// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Keyboard shortcut commands. Playwright's key presses go to the page, not to the
 * browser's shortcut handling, so the commands are sent as the `command` message the
 * popup uses, which runs the same code as `chrome.commands.onCommand`.
 */
import { test, expect } from './helpers/extension-context.js';

/** An extension page to send messages from, plus the fixture page in front of it. */
async function setUp(context, extensionId, mockServerUrl) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options/options.html`);
  await ext.waitForTimeout(300); // lets the fixture's init script save the server URL
  const page = await context.newPage();
  await page.goto(`${mockServerUrl}/fixtures/test-page.html`);
  await page.waitForFunction(() => !!document.getElementById('__lyra-hl-style'));
  await page.bringToFront();
  const command = (name) =>
    ext.evaluate((command) => chrome.runtime.sendMessage({ action: 'command', command }), name);
  return { page, command };
}

test.describe('Keyboard shortcuts', () => {
  test('the manifest declares the shortcuts, four with default keys', async ({
    context,
    extensionId,
  }) => {
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/options/options.html`);
    const commands = await ext.evaluate(() => chrome.commands.getAll());
    const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
    for (const name of ['read-selection', 'read-page', 'toggle-pause', 'stop']) {
      expect(byName[name], name).toBeTruthy();
    }
    expect(byName).toHaveProperty('back');
    expect(byName).toHaveProperty('forward');
    await expect(ext.locator('#shortcuts dt').first()).toHaveText('Read the selected text aloud');
  });

  test('read page reads the article to the end', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page, command } = await setUp(context, extensionId, mockServerUrl);
    await command('read-page');
    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 15_000 });
  });

  test('read selection reads the selected text', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page, command } = await setUp(context, extensionId, mockServerUrl);
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('p1'));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    await command('read-selection');
    await expect(page.locator('#__lyra-label')).toHaveText('Done.', { timeout: 15_000 });
  });

  test('read selection without a selection says so', async ({
    context,
    extensionId,
    mockServerUrl,
  }) => {
    const { page, command } = await setUp(context, extensionId, mockServerUrl);
    await command('read-selection');
    await expect(page.locator('#__lyra-label')).toHaveText('Error: Select some text first');
  });
});
