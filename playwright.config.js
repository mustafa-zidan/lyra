// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: 'tests/extension',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Global setup starts the mock TTS HTTP server on a dynamic port
  globalSetup: './tests/extension/helpers/global-setup.js',

  projects: [
    {
      // Pure Node unit tests — no browser required.
      // Tests import only the exported pure functions from background.js.
      name: 'unit',
      testMatch: ['**/background.test.js'],
      use: {},
    },
    {
      // Browser integration tests — load Chromium with the extension
      name: 'chromium-extension',
      testMatch: ['**/content.test.js', '**/popup.test.js'],
      use: {
        // Actual context launch is handled by the extension-context fixture
        browserName: 'chromium',
      },
    },
  ],
});
