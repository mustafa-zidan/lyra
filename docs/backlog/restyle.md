# Backlog: Restyle the Extension

## Goal

Visual refresh of the popup, options page, and in-page status bar.
Keep the indigo brand palette; improve polish without restructuring the HTML.

---

## Popup (`extension/popup/popup.css` + minor `popup.html` tweak)

### Changes

- Width: 280px → **300px**
- Header: solid `#4f46e5` → **gradient** `linear-gradient(135deg, #4338ca 0%, #6366f1 100%)`
  plus `box-shadow: inset 0 -1px 0 rgba(0,0,0,0.15)` for depth
- Logo: add `box-shadow: 0 2px 8px rgba(0,0,0,0.25)`
- `h1` font size: 16px → **17px**, weight 600 → **700**
- Status badge `badge--ok`: use `background: rgba(187,247,208,0.9); color: #14532d`
- Buttons: increase `border-radius` 8px → **10px**; add `letter-spacing: 0.01em`
- `btn--primary`: add `box-shadow: 0 2px 6px rgba(79,70,229,0.4)` on hover
- `btn--secondary`: `#e0e7ff` → `#ede9fe` background
- `btn--danger`: add `border: 1px solid #fca5a5`
- Footer `border-top`: `#e5e7eb` → `#ede9fe` (soft purple tint)
- Footer link: increase size 12px → **13px**; add hover color `#6366f1`
- Add `padding-bottom: 2px` to body for a small bottom breathing room

### `popup.html` — no structural changes needed

---

## Options page (`extension/options/options.css`)

### Changes

- Body background: `#f9fafb` → **`#f5f3ff`** (very faint violet, matches popup)
- Page header `h1` color: flat `#4f46e5` → **gradient text**
  (`background: linear-gradient(90deg, #4f46e5, #818cf8); -webkit-background-clip: text;
  -webkit-text-fill-color: transparent`)
- Cards: improve shadow:
  `box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(99,102,241,0.06)`
- Card `border-color`: `#e5e7eb` → `#e0e7ff`
- `field__input` focus ring: `rgba(99,102,241,0.15)` → `rgba(99,102,241,0.2)` + thicker
  border `2px solid #6366f1`
- `btn--primary` hover: `opacity` → `background: #4338ca` + `box-shadow`
- `save-msg` color: `#059669` → `#4f46e5` (brand green → brand indigo)
- `server-status--ok`: `#dcfce7 / #166534` → `#d1fae5 / #065f46`

---

## Content script status bar (`extension/content.js`)

Replace the full-width bottom bar with a **floating pill** anchored bottom-right.

### Inline style changes in `getOrCreateStatusBar()`

```js
// BEFORE
Object.assign(statusBar.style, {
  position: 'fixed',
  bottom: '0',
  left: '0',
  right: '0',
  zIndex: '2147483647',
  background: 'rgba(30, 27, 75, 0.95)',
  ...
  transform: 'translateY(100%)',
});

// AFTER
Object.assign(statusBar.style, {
  position: 'fixed',
  bottom: '20px',
  right: '20px',
  left: 'auto',          // ← unset left stretch
  zIndex: '2147483647',
  maxWidth: '320px',
  background: 'rgba(30, 27, 75, 0.95)',
  color: '#e0e7ff',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '13px',
  padding: '8px 14px',
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  borderRadius: '24px',   // ← pill shape
  boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
  backdropFilter: 'blur(8px)',
  transition: 'opacity 0.25s ease, transform 0.25s ease',
  opacity: '0',
  transform: 'translateY(8px)',   // ← slide up from below instead of full-height slide
});
```

Update `showStatusBar` / `hideStatusBar` to animate opacity + translateY instead of
the full `translateY(100%)`:

```js
function showStatusBar(text) {
  const bar = getOrCreateStatusBar();
  const label = document.getElementById('__lyra-label');
  if (label) label.textContent = text;
  bar.style.opacity = '1';
  bar.style.transform = 'translateY(0)';
}

function hideStatusBar() {
  if (statusBar) {
    statusBar.style.opacity = '0';
    statusBar.style.transform = 'translateY(8px)';
  }
}
```

Stop button: `border-radius` → `99px` for pill shape; add `font-size: 12px`.

---

## Playwright test impact

No selector changes — IDs (`__lyra-status`, `__lyra-label`) are unchanged.
The `content.test.js` checks `display` via `getComputedStyle`, not CSS geometry,
so position/border-radius changes don't affect test assertions.

Popup tests check text content and `disabled` state — CSS changes are transparent.

**All 22 tests should continue to pass unchanged.**

---

## Verification checklist

- [ ] Load popup in Chrome → gradient header visible, 300px wide
- [ ] Status badge shows green/red correctly
- [ ] Open Options page → violet background, gradient title
- [ ] Navigate to a page, trigger TTS → pill appears bottom-right, slides in smoothly
- [ ] `pnpm run test:ext` → all 22 tests pass
