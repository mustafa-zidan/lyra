// SPDX-License-Identifier: AGPL-3.0-only
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(__dirname, '../extension/icons/icon.svg');
const svgContent = readFileSync(svgPath, 'utf8');

// Strip outer <svg> tags — we re-wrap with explicit width/height per size
const inner = svgContent.replace(/<\/?svg[^>]*>/g, '');

const sizes = [16, 48, 128];
const browser = await chromium.launch();

for (const size of sizes) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html>
<html><head><style>*{margin:0;padding:0}</style></head>
<body>
  <svg xmlns="http://www.w3.org/2000/svg"
       width="${size}" height="${size}" viewBox="0 0 128 128">
    ${inner}
  </svg>
</body></html>`);
  const buf = await page.screenshot({
    clip: { x: 0, y: 0, width: size, height: size },
  });
  const out = resolve(__dirname, `../extension/icons/icon-${size}.png`);
  writeFileSync(out, buf);
  console.log(`✓ icon-${size}.png`);
  await page.close();
}

await browser.close();
