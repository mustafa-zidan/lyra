// SPDX-License-Identifier: AGPL-3.0-only
// Firefox exposes `browser`; Chrome exposes `chrome`.
// Both are in scope as globals in content/background scripts.
declare const browser: typeof chrome | undefined;
