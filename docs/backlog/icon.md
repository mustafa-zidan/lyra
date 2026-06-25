# Backlog: Generate a Nicer Icon

## Goal

Replace the three placeholder PNGs with a proper Lyra icon: a rounded-square
indigo background with a white speaker + soundwave symbol. Generate all sizes
from a single SVG source using Playwright (already a devDependency).

---

## Icon design — `extension/icons/icon.svg`

Rounded-square (rx=28) indigo background. Three elements:

1. Solid speaker body (filled polygon)
2. Near sound-wave arc
3. Far sound-wave arc (slightly transparent for depth)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <!-- Background -->
  <rect width="128" height="128" rx="28" fill="#4f46e5"/>

  <!-- Speaker body -->
  <path d="M34 50 L52 38 L52 90 L34 78 Z" fill="white"/>
  <rect x="22" y="50" width="14" height="28" rx="3" fill="white"/>

  <!-- Near arc -->
  <path d="M60 50 Q74 64 60 78"
        stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/>

  <!-- Far arc -->
  <path d="M68 42 Q88 64 68 86"
        stroke="white" stroke-width="6" fill="none" stroke-linecap="round"
        opacity="0.65"/>
</svg>
```

Fine-tune the paths visually before generating PNGs — the SVG is the source of truth.

---

## Generation script — `scripts/generate-icons.js`

```js
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
```

---

## `package.json` addition

```json
"generate-icons": "node scripts/generate-icons.js"
```

---

## Files

| Path                           | Action                                     |
|--------------------------------|--------------------------------------------|
| `extension/icons/icon.svg`     | Create                                     |
| `scripts/generate-icons.js`    | Create                                     |
| `extension/icons/icon-16.png`  | Regenerate (run `pnpm run generate-icons`) |
| `extension/icons/icon-48.png`  | Regenerate                                 |
| `extension/icons/icon-128.png` | Regenerate                                 |
| `package.json`                 | Add `generate-icons` script                |

---

## Running

```bash
pnpm run generate-icons
```

Requires Playwright Chromium to be installed (`pnpm exec playwright install chromium`).

---

## Verification checklist

- [ ] `pnpm run generate-icons` exits 0, three PNGs updated
- [ ] Load unpacked extension in Chrome → icon visible in toolbar and extensions page
- [ ] Load in Firefox → icon visible in toolbar
- [ ] 16px icon is legible (rounded square with recognisable speaker shape)
- [ ] 128px icon looks sharp in the Chrome Web Store preview size
- [ ] `pnpm run test:ext` → all 22 tests pass (icon change has no effect on tests)
