# Backlog: Switch Extension to TypeScript

## Goal
Add static typing to the extension source. Move `.js` files to `src/` as `.ts`,
compile to `extension/` with `tsc`. The compiled `.js` files are gitignored; CI
builds before running tests.

---

## Directory layout after migration

```
src/                          ← TypeScript source (new)
  background.ts               ← moved from extension/background.js
  chunk-text.ts               ← moved from extension/chunk-text.js
  content.ts                  ← moved from extension/content.js
  popup/popup.ts              ← moved from extension/popup/popup.js
  options/options.ts          ← moved from extension/options/options.js
  types.d.ts                  ← new: global browser/chrome declaration

extension/                    ← static assets (unchanged) + compiled JS output
  manifest.json
  icons/
  popup/popup.html, popup.css
  options/options.html, options.csse
  background.js               ← generated (gitignored after migration)
  chunk-text.js               ← generated (gitignored)
  content.js                  ← generated (gitignored)
  popup/popup.js              ← generated (gitignored)
  options/options.js          ← generated (gitignored)
```

---

## Step 1 — New devDependencies (`package.json`)

```json
"typescript": "^5.8.0",
"@types/chrome": "^0.0.320",
"typescript-eslint": "^8.0.0"
```

New scripts:
```json
"build:ts":   "tsc",
"typecheck":  "tsc --noEmit"
```

Update existing scripts:
```json
"lint:js":          "eslint src/",
"lint:js:fix":      "eslint src/ --fix",
"format:js":        "prettier --write \"src/**/*.{ts,json,css,html}\"",
"format:js:check":  "prettier --check \"src/**/*.{ts,json,css,html}\"",
"test:ext":         "tsc && playwright test"
```

---

## Step 2 — `tsconfig.json` (root)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "outDir": "extension",
    "rootDir": "src",
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"]
}
```

Key notes:
- `background.ts` has no `import`/`export` → TypeScript outputs it as a plain
  script (no module boilerplate). Firefox MV3 compat preserved.
- `chunk-text.ts` keeps `export function chunkText` → outputs as ES module.

---

## Step 3 — `src/types.d.ts`

```typescript
// Firefox exposes `browser`; Chrome exposes `chrome`.
// Both are in scope as globals in content/background scripts.
declare const browser: typeof chrome | undefined;
```

---

## Step 4 — Type annotations per file

### `src/background.ts`
```typescript
interface Settings {
  serverUrl: string;
  defaultVoice: string;
}

interface ExtMessage {
  action: 'speak' | 'stop' | 'get-voices' | 'health';
  text?: string;
  voice?: string;
  serverUrl?: string;
}

// All existing functions get explicit return types:
// getSettings(): Promise<Settings>
// handleMessage(message: ExtMessage, sender: chrome.runtime.MessageSender): Promise<object>
// speakInTab(tabId: number, text: string, voice: string, serverUrl: string): Promise<void>
// fetchTTS(text: string, voice: string, serverUrl: string): Promise<string>
// fetchVoices(serverUrl: string): Promise<chrome.runtime.Port[]>   // actually Voice[]
// notifyTab(tabId: number, payload: object): void
// getActiveTabId(): Promise<number | null>
// playAudioInPage(audioDataUrl: string): Promise<void>
```

### `src/chunk-text.ts`
```typescript
export function chunkText(text: string, maxLen = 500): string[]
```

### `src/content.ts`
```typescript
interface TextEntry {
  node: Text;
  start: number;
  end: number;
}
// textIndex: TextEntry[]
// All DOM-touching functions: return void
// Message action union type (same as background.ts, can share via types.d.ts)
```

### `src/popup/popup.ts` and `src/options/options.ts`
- DOM refs typed with `as HTMLElement`, `as HTMLSelectElement`, `as HTMLInputElement`
- Async helpers get explicit return types

---

## Step 5 — `eslint.config.js` update

```js
import tsEslint from 'typescript-eslint';

export default tsEslint.config(
  js.recommended,
  {
    // plain-script extension files (compiled output — not linted directly)
    files: ['extension/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
    rules: { 'no-undef': 'off' },
  },
  {
    // TypeScript source
    files: ['src/**/*.ts'],
    extends: [...tsEslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
      parserOptions: { project: './tsconfig.json' },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // background.ts — plain script (no module), no-undef off
    files: ['src/background.ts', 'src/content.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'error' },
  },
  {
    // chunk-text.ts — ES module
    files: ['src/chunk-text.ts'],
    languageOptions: { sourceType: 'module' },
  },
);
```

---

## Step 6 — `.gitignore` additions

```
# TypeScript compiled output
extension/background.js
extension/chunk-text.js
extension/content.js
extension/popup/popup.js
extension/options/options.js
```

---

## Step 7 — CI update (`.github/workflows/test.yml`)

In the extension job, before the Playwright test step add:

```yaml
- name: Build TypeScript
  run: pnpm run build:ts
```

---

## Step 8 — Pre-commit update (`.pre-commit-config.yaml`)

Update the local ESLint and Prettier hooks to target `src/`:
```yaml
- id: eslint
  entry: pnpm exec eslint --fix
  types: [ts]          # was: [javascript]

- id: prettier
  entry: pnpm exec prettier --write
  types_or: [ts, json, css, html]   # was: [javascript, json, css, html]
```

---

## Verification checklist

- [ ] `pnpm run build:ts` → 0 errors, JS files appear in `extension/`
- [ ] `pnpm run typecheck` → 0 type errors
- [ ] `pnpm run lint:js` → 0 lint errors on `src/`
- [ ] `pnpm run test:ext` → all 22 tests pass (tsc runs first automatically)
- [ ] Load unpacked extension in Chrome → works normally
- [ ] Load in Firefox → works normally
