# Lyra — Project Memory

## Project Overview
Web server + browser extension for the `eurydice-tts` TTS library. Project name: **Lyra**.
- **Server**: FastAPI + uvicorn at `http://127.0.0.1:8000`
- **Extension**: Manifest V3 ES module service worker, Chrome + Firefox, TypeScript
- **Parent library**: `../eurydice` (eurydice-tts package, Python 3.12+)
- **License**: AGPL-3.0-only

## Key Files
- `pyproject.toml` — uv project config; eurydice-tts sourced via `[tool.uv.sources]`
- `server/main.py` — FastAPI app factory + lifespan
- `server/core/config.py` — pydantic-settings, env prefix `EURYDICE_`
- `server/core/tts_service.py` — Eurydice client singleton
- `server/api/routes/tts.py` — POST /tts/generate (returns binary WAV)
- `extension/manifest.json` — MV3 with `"type": "module"` for service worker
- `src/background.ts` — ES module service worker (compiled → extension/background.js)
- `src/chunk-text.ts` — exported chunkText for unit tests
- `src/content.ts` — IIFE content script (compiled → extension/content.js)
- `src/popup/popup.ts` — popup script (compiled → extension/popup/popup.js)
- `src/options/options.ts` — options script (compiled → extension/options/options.js)
- `src/types.d.ts` — global browser declaration
- `tsconfig.json` — rootDir: src, outDir: extension, ES2022, strict
- `playwright.config.js` — two projects: unit (Node) + chromium-extension
- `tests/extension/helpers/extension-context.js` — Playwright fixture
- `tests/extension/helpers/global-setup.js` — mock HTTP server (dynamic port)
- `scripts/generate-icons.js` — Playwright-based PNG generation from icon.svg
- `extension/icons/icon.svg` — B&W flat design source SVG

## Design Language
**Black and white flat design** — no color palette:
- Background: `#fff` / `#f5f5f5`
- Primary: `#111` (near-black)
- Borders: `2px solid #111` (strong), `1px solid #ccc` (subtle)
- Border-radius: `2px` (flat/square feel)
- Typography: bold, uppercase labels with `letter-spacing`
- Status bar pill → rectangular with `border-radius: 2px`
- Highlight: `background: #000; color: #fff`

## Critical uv Configuration
- Use `[tool.uv.sources]` (NOT inline `@ path`) for local path deps
- Must set `[tool.hatch.metadata] allow-direct-references = true`

## Dependency Versions (resolved 2026-02-21 / updated 2026-03-01)
- fastapi==0.129.1, uvicorn==0.41.0, pydantic-settings==2.13.1
- pytest==9.0.2, ruff==0.15.2, pre-commit>=4.0.0
- @playwright/test ^1.50.0, eslint ^9.20.0, prettier ^3.5.0
- typescript ^5.9.3, @types/chrome ^0.1.37, typescript-eslint ^8.56.1

## Quality Gates
1. `uv run ruff check .` → 0 errors
2. `uv run ruff format --check .` → no diffs
3. `uv run pytest` → Python tests pass
4. `pnpm run test:ext` → 22 tests pass (6 unit + 16 integration); runs tsc first
5. `pnpm run typecheck` → 0 TypeScript errors

## Tooling — JS
- **Package manager**: pnpm (user preference — always use pnpm, never npm)
- **Test runner**: `pnpm run test:ext` (runs tsc then playwright)
- **Build TS**: `pnpm run build:ts` (tsc, src/ → extension/)
- **Lint**: `pnpm run lint:js` (ESLint 9 flat config with typescript-eslint)
- **Format**: `pnpm run format:js` (Prettier)
- **Icons**: `pnpm run generate-icons` (Playwright Chromium renders icon.svg)
- ESLint config: `eslint.config.js` — TypeScript-ESLint on src/, ignores extension/**/*.js

## TypeScript Architecture
- Source in `src/`, compiled output in `extension/` (gitignored JS files)
- All .ts files are ES modules (have `export {}` at minimum)
- `src/types.d.ts` declares global `browser: typeof chrome | undefined`
- `background.ts` and `popup.ts`/`options.ts` use `api = typeof browser !== 'undefined' ? browser : chrome`
- Popup/options HTML use `<script type="module" src="...js">`
- Manifest background has `"type": "module"`
- `src/content.ts` wraps everything in an IIFE (content scripts can't be modules)

## Extension Critical Notes
- **background.js must use `.addListener()` NOT `.addEventListener()`** on Chrome extension
  event objects (`api.runtime.onInstalled`, `api.contextMenus.onClicked`, `api.runtime.onMessage`)
- All top-level `api.*` calls are guarded with `if (api)` so the file can be imported
  in Node.js for unit testing (api is null in Node)
- **NEVER add `import {browser} from "globals"` to any source file** — browser global is
  declared in src/types.d.ts and eslint.config.js globals

## Playwright Extension Testing
- **headless: false required** — Chrome extension service workers do NOT register in
  headless mode (tested: `headless: true` and `--headless=old` both fail)
- Extension ID: `bdbonppalndpejolbpiepnceehmodfmf` (consistent for this extension dir)
- Content scripts only match `http://` and `https://` URLs (not `file://`) — test
  fixtures are served via the mock HTTP server at `http://127.0.0.1:{port}/fixtures/`
- For CI (Linux): wrap playwright test with `xvfb-run --auto-servernum`
- Mock server uses dynamic port (port 0) written to `$TMPDIR/lyra-test-server-port`

## Extension Cross-browser Shim
```js
const api = typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
```
- `browser_specific_settings.gecko.id` = `lyra-tts@extension`
- Firefox MV3 uses `"service_worker"` with `"type": "module"` (supported FF 128+)

# currentDate
Today's date is 2026-03-01.
