// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared Playwright fixture: launches Chromium with the Lyra extension loaded
 * and the mock server URL pre-seeded into extension storage.
 */
import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { PORT_FILE } from './global-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../../extension');

/** Read the port written by global-setup; fall back to 8000. */
function getMockServerPort() {
  try {
    return parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
  } catch {
    return 8000;
  }
}

export const test = base.extend({
  context: async ({}, use) => {
    const port = getMockServerPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-ext-'));

    const context = await chromium.launchPersistentContext(tmpDir, {
      // Chrome extension service workers require a real display; headless mode
      // does not support them. On Linux CI use xvfb-run; locally a display is available.
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    // Pre-seed extension storage with the dynamic server URL
    await context.addInitScript(
      ({ url }) => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ serverUrl: url, defaultVoice: 'af_heart' });
        }
      },
      { url: serverUrl },
    );

    await use(context);
    await context.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },

  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    const id = background.url().split('/')[2];
    await use(id);
  },

  mockServerUrl: async ({}, use) => {
    const port = getMockServerPort();
    await use(`http://127.0.0.1:${port}`);
  },
});

export { expect } from '@playwright/test';
