// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saved settings, shared by the background worker, popup and options page.
 *
 * The content script is a classic script and can't import this module, so it keeps
 * its own copy of the display defaults (see `content.ts`); keep the two in step.
 */

export type HighlightStyle = 'background' | 'underline' | 'both';
export type FocusMode = 'off' | 'ruler' | 'spotlight';
export type ReaderFont = 'system' | 'atkinson' | 'opendyslexic';
export type ReaderTheme = 'cream' | 'white' | 'blue' | 'dark';

export interface Settings {
  serverUrl: string;
  defaultVoice: string;
  selectedModel: string;
  /** Speaking rate sent with every chunk: 1 is normal. */
  speed: number;
  /** Colour of the sentence/chunk being read. */
  highlightColor: string;
  highlightStyle: HighlightStyle;
  /** Light text on a dark highlight, for readers who need stronger contrast. */
  highContrast: boolean;
  /** Alt+click (Option+click) a paragraph to read from there to the end. */
  clickToRead: boolean;
  /** Highlight the word being spoken, and narrow the passage highlight to its sentence. */
  wordHighlight: boolean;
  /** Colour of the word being spoken. */
  wordColor: string;
  /** Reading aid: a ruler band on the current line, or dim all but the paragraph. */
  focusMode: FocusMode;
  /** Reader view text settings (changed in the view itself). */
  readerFont: ReaderFont;
  /** Font size in px. */
  readerSize: number;
  readerLineHeight: number;
  /** Letter and word spacing in em. */
  readerLetterSpacing: number;
  readerWordSpacing: number;
  /** Line length in characters. */
  readerWidth: number;
  readerTheme: ReaderTheme;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://127.0.0.1:8000',
  defaultVoice: 'af_heart',
  selectedModel: 'mlx-community/Kokoro-82M-bf16',
  speed: 1,
  highlightColor: '#dcd7fc',
  highlightStyle: 'background',
  highContrast: false,
  clickToRead: true,
  wordHighlight: true,
  wordColor: '#ffd84d',
  focusMode: 'off',
  readerFont: 'atkinson',
  readerSize: 20,
  readerLineHeight: 1.8,
  readerLetterSpacing: 0.03,
  readerWordSpacing: 0.12,
  readerWidth: 60,
  readerTheme: 'cream',
};

/** Slowest and fastest speed the popup and options offer (the server accepts 0.5–2). */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** Preset highlight colours offered in the options page. */
export const HIGHLIGHT_PRESETS: { name: string; color: string }[] = [
  { name: 'Purple', color: '#dcd7fc' },
  { name: 'Yellow', color: '#fff3a3' },
  { name: 'Green', color: '#c8f2c2' },
  { name: 'Blue', color: '#cfe5ff' },
  { name: 'Pink', color: '#ffd3e8' },
];

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
