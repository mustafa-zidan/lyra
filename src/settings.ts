// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saved settings, shared by the background worker, popup and options page.
 */

export interface Settings {
  serverUrl: string;
  defaultVoice: string;
  selectedModel: string;
  /** Speaking rate sent with every chunk: 1 is normal. */
  speed: number;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://127.0.0.1:8000',
  defaultVoice: 'af_heart',
  selectedModel: 'mlx-community/Kokoro-82M-bf16',
  speed: 1,
};

/** Slowest and fastest speed the popup and options offer (the server accepts 0.5–2). */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

export function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    api.storage.local.get({ ...DEFAULT_SETTINGS }, (items) =>
      resolve(items as unknown as Settings),
    );
  });
}

export function saveSettings(values: Partial<Settings>): Promise<void> {
  return new Promise((resolve) => api.storage.local.set(values, resolve));
}

/** "1×", "0.8×", "1.25×". */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}
