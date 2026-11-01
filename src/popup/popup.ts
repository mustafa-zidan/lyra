/**
 * Lyra TTS: Popup Script
 */

import { formatSpeed, getSettings, saveSettings } from '../settings.js';

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusBadge = document.getElementById('status-badge') as HTMLElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;
const languageFilter = document.getElementById('language-filter') as HTMLSelectElement;
const genderFilter = document.getElementById('gender-filter') as HTMLSelectElement;
const btnSelection = document.getElementById('btn-read-selection') as HTMLButtonElement;
const btnPage = document.getElementById('btn-read-page') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const optionsLink = document.getElementById('options-link') as HTMLAnchorElement;
const speedInput = document.getElementById('speed') as HTMLInputElement;
const speedValue = document.getElementById('speed-value') as HTMLOutputElement;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Voice {
  id: string;
  name: string;
  language?: string | null;
  gender?: string | null;
  default?: boolean;
}

// Full voice list for the active model; the visible voice dropdown is a
// language/gender-filtered view of this.
let allVoices: Voice[] = [];
/** Voice we'd like to keep selected across filter changes (saved default first). */
let preferredVoice = '';

interface BackgroundResponse {
  ok: boolean;
  available?: boolean;
  voices?: Voice[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const { serverUrl, defaultVoice, selectedModel, speed } = await getSettings();

  // Speed is saved as it changes; the read in progress picks it up from its next chunk.
  speedInput.value = String(speed);
  speedValue.textContent = formatSpeed(speed);
  speedInput.addEventListener('input', () => {
    const value = Number(speedInput.value);
    speedValue.textContent = formatSpeed(value);
    saveSettings({ speed: value });
  });

  // Check server health
  const health = await sendBackground({ action: 'health', serverUrl });
  updateStatusBadge(health.available ?? false);

  // Load voices for the selected model
  try {
    const { voices } = await sendBackground({
      action: 'get-voices',
      serverUrl,
      model: selectedModel,
    });
    setVoices(voices ?? [], defaultVoice);
    btnSelection.disabled = false;
    btnPage.disabled = false;
  } catch {
    setVoices([], defaultVoice);
  }

  // Options link
  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
  });

  // Re-filter the voice list when language/gender preselectors change
  languageFilter.addEventListener('change', applyVoiceFilter);
  genderFilter.addEventListener('change', applyVoiceFilter);

  // Button handlers
  btnSelection.addEventListener('click', () => readSelection(serverUrl, selectedModel));
  btnPage.addEventListener('click', () => readPage(serverUrl, selectedModel));
  btnStop.addEventListener('click', stopPlayback);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function readSelection(serverUrl: string, model: string): Promise<void> {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  const response = (await api.tabs.sendMessage(tab.id, { action: 'get-selection' })) as
    { text?: string; language?: string } | undefined;
  const text = response?.text?.trim();
  if (!text) {
    statusBadge.textContent = 'No text selected';
    statusBadge.className = 'badge badge--error';
    return;
  }

  setPlaying(true);
  await sendBackground({
    action: 'speak',
    text,
    voice: voiceSelect.value,
    serverUrl,
    model,
    language: response?.language,
  });
}

async function readPage(serverUrl: string, model: string): Promise<void> {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  // Inject Readability.js into the page's content-script world
  await api.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['/vendor/Readability.js'],
  });

  // Extract readable content with fallback chain
  const [result] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const language = document.documentElement.lang || undefined;
      const clone = document.cloneNode(true) as Document;
      try {
        // @ts-expect-error Readability injected as global by prior executeScript
        const article = new Readability(clone).parse();
        if (article?.textContent?.trim()) {
          return { text: article.textContent.trim(), language: article.lang || language };
        }
      } catch {
        /* fall through to fallback */
      }

      // Fallback: semantic HTML elements
      for (const sel of ['article', 'main', '[role="main"]']) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim() && el.textContent.trim().length > 100) {
          return { text: el.textContent.trim(), language };
        }
      }
      // Last resort: full page text
      return { text: document.body.innerText, language };
    },
  });

  const page = result?.result as { text?: string; language?: string } | undefined;
  const text = page?.text?.trim();
  if (!text) return;

  setPlaying(true);
  await sendBackground({
    action: 'speak',
    text,
    voice: voiceSelect.value,
    serverUrl,
    model,
    language: page?.language,
  });
}

async function stopPlayback(): Promise<void> {
  setPlaying(false);
  await sendBackground({ action: 'stop' });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateStatusBadge(available: boolean): void {
  if (available) {
    statusBadge.textContent = 'Online';
    statusBadge.className = 'badge badge--ok';
  } else {
    statusBadge.textContent = 'Server offline';
    statusBadge.className = 'badge badge--error';
  }
}

/**
 * Store the full voice list, populate the language/gender preselectors from
 * the available metadata, and render the (filtered) voice dropdown.
 */
function setVoices(voices: Voice[], defaultVoice: string): void {
  allVoices = voices;
  preferredVoice = defaultVoice;
  populateFilterOptions(
    languageFilter,
    voices.map((v) => v.language),
  );
  populateFilterOptions(
    genderFilter,
    voices.map((v) => v.gender),
  );
  applyVoiceFilter();
}

/** Fill a filter <select> with the distinct, non-empty values (plus "All"). */
function populateFilterOptions(
  select: HTMLSelectElement,
  values: (string | null | undefined)[],
): void {
  const distinct = [...new Set(values.filter((v): v is string => !!v))].sort();
  select.innerHTML = '<option value="">All</option>';
  // Hide the filter entirely when there's nothing to narrow by (≤1 option).
  const wrapper = select.closest('.filter') as HTMLElement | null;
  if (wrapper) wrapper.style.display = distinct.length > 1 ? '' : 'none';
  for (const value of distinct) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
}

/** Render the voice dropdown filtered by the current language/gender selection. */
function applyVoiceFilter(): void {
  const lang = languageFilter.value;
  const gender = genderFilter.value;
  const previous = voiceSelect.value || preferredVoice;

  const filtered = allVoices.filter(
    (v) => (!lang || v.language === lang) && (!gender || v.gender === gender),
  );

  voiceSelect.innerHTML = '';
  if (filtered.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = allVoices.length === 0 ? 'Default' : 'No matching voices';
    voiceSelect.appendChild(opt);
    return;
  }

  for (const v of filtered) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    voiceSelect.appendChild(opt);
  }

  // Keep the prior/preferred selection if it survived the filter; else first.
  const keep = filtered.find((v) => v.id === previous) ?? filtered.find((v) => v.default);
  voiceSelect.value = keep ? keep.id : filtered[0].id;
}

function setPlaying(playing: boolean): void {
  btnSelection.style.display = playing ? 'none' : '';
  btnPage.style.display = playing ? 'none' : '';
  btnStop.style.display = playing ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sendBackground(message: Record<string, unknown>): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, (response) => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
      } else {
        resolve((response as BackgroundResponse) ?? {});
      }
    });
  });
}

function getTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    api.tabs.query({ active: true, currentWindow: true }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

export {};
