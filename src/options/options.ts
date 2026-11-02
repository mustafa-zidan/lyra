/**
 * Lyra TTS: Options Page Script
 */

import {
  DEFAULT_SETTINGS,
  formatSpeed,
  getSettings,
  HIGHLIGHT_PRESETS,
  saveSettings as save,
  type HighlightStyle,
  type Settings,
} from '../settings.js';

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SERVER_URL = DEFAULT_SETTINGS.serverUrl;
const DEFAULT_VOICE = DEFAULT_SETTINGS.defaultVoice;
const DEFAULT_MODEL = DEFAULT_SETTINGS.selectedModel;
/** A Test sound taking longer than this is probably loading (or downloading) the model. */
const SLOW_REQUEST_MS = 8000;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const defaultVoiceSelect = document.getElementById('default-voice') as HTMLSelectElement;
const languageFilter = document.getElementById('language-filter') as HTMLSelectElement;
const genderFilter = document.getElementById('gender-filter') as HTMLSelectElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnTestSound = document.getElementById('btn-test-sound') as HTMLButtonElement;
const serverStatus = document.getElementById('server-status') as HTMLElement;
const saveMsg = document.getElementById('save-msg') as HTMLElement;
const testStatus = document.getElementById('test-status') as HTMLElement;
const speedInput = document.getElementById('speed') as HTMLInputElement;
const speedValue = document.getElementById('speed-value') as HTMLOutputElement;
const swatches = document.getElementById('highlight-swatches') as HTMLElement;
const highlightColorInput = document.getElementById('highlight-color') as HTMLInputElement;
const highlightStyleSelect = document.getElementById('highlight-style') as HTMLSelectElement;
const highContrastInput = document.getElementById('high-contrast') as HTMLInputElement;
const preview = document.getElementById('highlight-preview') as HTMLElement;
const wordHighlightInput = document.getElementById('word-highlight') as HTMLInputElement;
const wordColorInput = document.getElementById('word-color') as HTMLInputElement;
const clickToReadInput = document.getElementById('click-to-read') as HTMLInputElement;
const shortcutList = document.getElementById('shortcuts') as HTMLElement;
const btnShortcuts = document.getElementById('btn-shortcuts') as HTMLButtonElement;

let testAudio: HTMLAudioElement | null = null;
let testAudioUrl: string | null = null;
let testFetch: AbortController | null = null;

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

// Full voice list for the selected model; the visible voice dropdown is a
// language/gender-filtered view of this.
let allVoices: Voice[] = [];
/** Voice to keep selected across filter changes (saved default first). */
let preferredVoice = '';

interface ModelInfo {
  id: string;
  name: string;
  description: string;
  languages: string[];
  default: boolean;
}

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  const { serverUrl, defaultVoice, selectedModel } = settings;
  serverUrlInput.value = serverUrl;
  showReadingSettings(settings);

  // Try to populate models and voices from the server
  try {
    const modelsResp = (await api.runtime.sendMessage({ action: 'get-models', serverUrl })) as
      { models?: ModelInfo[] } | undefined;
    if (modelsResp?.models?.length) {
      populateModels(modelsResp.models, selectedModel);
    } else {
      populateModels([], selectedModel);
    }
  } catch {
    populateModels([], selectedModel);
  }

  await refreshVoices(serverUrl, modelSelect.value || selectedModel, defaultVoice);
}

// ---------------------------------------------------------------------------
// Check server connectivity
// ---------------------------------------------------------------------------

async function checkServer(): Promise<void> {
  const url = serverUrlInput.value.trim();
  if (!url) {
    setStatus('Enter a server URL first.', 'error');
    return;
  }

  setStatus('Checking…', 'idle');
  try {
    const healthResp = (await api.runtime.sendMessage({ action: 'health', serverUrl: url })) as
      { available?: boolean; status?: string } | undefined;

    if (!healthResp?.available) {
      setStatus('Server reachable but TTS backend offline.', 'error');
      return;
    }

    setStatus(`Connected ✓  (provider: ${healthResp.status ?? 'ok'})`, 'ok');

    // Refresh models
    const modelsResp = (await api.runtime.sendMessage({ action: 'get-models', serverUrl: url })) as
      { models?: ModelInfo[] } | undefined;
    if (modelsResp?.models?.length) {
      populateModels(modelsResp.models, modelSelect.value);
    }

    // Refresh voices for current model
    await refreshVoices(url, modelSelect.value, defaultVoiceSelect.value);
  } catch (err) {
    setStatus(`Cannot reach server: ${(err as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function refreshVoices(
  serverUrl: string,
  modelId: string,
  selectedVoiceId: string,
): Promise<void> {
  try {
    const resp = (await api.runtime.sendMessage({
      action: 'get-voices',
      serverUrl,
      model: modelId,
    })) as { voices?: Voice[] } | undefined;

    if (resp?.voices?.length) {
      setVoices(resp.voices, selectedVoiceId);
    } else {
      setVoices([], selectedVoiceId);
    }
  } catch {
    setVoices([], selectedVoiceId);
  }
}

/** Display name for a language code from `/models`, e.g. "de" → "German". */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function populateModels(modelList: ModelInfo[], selectedId: string): void {
  const current = modelSelect.value;
  modelSelect.innerHTML = '';

  if (modelList.length === 0) {
    // Fallback: add only the default model as a placeholder
    const opt = document.createElement('option');
    opt.value = DEFAULT_MODEL;
    opt.textContent = 'Kokoro 82M (default)';
    modelSelect.appendChild(opt);
    modelSelect.value = selectedId || DEFAULT_MODEL;
    return;
  }

  for (const m of modelList) {
    const opt = document.createElement('option');
    opt.value = m.id;
    // Kokoro lists 9 languages: summarise long lists, full list in the tooltip.
    const names = m.languages.map(languageName);
    const summary = names.length <= 3 ? names.join(', ') : `${names.length} languages`;
    opt.textContent = `${m.name} — ${summary}`;
    opt.title = `${m.description}\nLanguages: ${names.join(', ')}`;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = selectedId || current || DEFAULT_MODEL;
}

/**
 * Store the full voice list, populate the language/gender preselectors from
 * the available metadata, and render the (filtered) voice dropdown.
 */
function setVoices(voices: Voice[], selectedId: string): void {
  allVoices = voices;
  preferredVoice = selectedId || defaultVoiceSelect.value || DEFAULT_VOICE;
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
  const wrapper = select.closest('.field') as HTMLElement | null;
  if (wrapper) wrapper.style.display = distinct.length > 1 ? '' : 'none';
  select.innerHTML = '<option value="">All</option>';
  for (const value of distinct) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.appendChild(opt);
  }
}

/** Render the default-voice dropdown filtered by the current language/gender selection. */
function applyVoiceFilter(): void {
  const lang = languageFilter.value;
  const gender = genderFilter.value;
  const previous = defaultVoiceSelect.value || preferredVoice;

  defaultVoiceSelect.innerHTML = '';

  if (allVoices.length === 0) {
    const opt = document.createElement('option');
    opt.value = DEFAULT_VOICE;
    opt.textContent = 'Default';
    defaultVoiceSelect.appendChild(opt);
    defaultVoiceSelect.value = previous || DEFAULT_VOICE;
    return;
  }

  const filtered = allVoices.filter(
    (v) => (!lang || v.language === lang) && (!gender || v.gender === gender),
  );

  if (filtered.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No matching voices';
    defaultVoiceSelect.appendChild(opt);
    return;
  }

  for (const v of filtered) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    defaultVoiceSelect.appendChild(opt);
  }

  const keep = filtered.find((v) => v.id === previous) ?? filtered.find((v) => v.default);
  defaultVoiceSelect.value = keep ? keep.id : filtered[0].id;
}

function setStatus(message: string, type: 'idle' | 'ok' | 'error'): void {
  serverStatus.textContent = message;
  serverStatus.className = `server-status server-status--${type}`;
}

/** Fill the Reading and Highlight cards' controls from saved (or default) settings. */
function showReadingSettings(settings: Settings): void {
  speedInput.value = String(settings.speed);
  speedValue.textContent = formatSpeed(settings.speed);
  highlightColorInput.value = settings.highlightColor;
  highlightStyleSelect.value = settings.highlightStyle;
  highContrastInput.checked = settings.highContrast;
  clickToReadInput.checked = settings.clickToRead;
  wordHighlightInput.checked = settings.wordHighlight;
  wordColorInput.value = settings.wordColor;
  syncSwatches();
  updatePreview();
}

/** The colour swatches: one radio per preset, then the custom colour picker. */
function renderSwatches(): void {
  for (const preset of HIGHLIGHT_PRESETS) {
    const label = document.createElement('label');
    label.className = 'swatch';
    label.title = preset.name;
    label.style.background = preset.color;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'highlight-preset';
    radio.value = preset.color;
    radio.setAttribute('aria-label', preset.name);
    radio.addEventListener('change', () => {
      highlightColorInput.value = preset.color;
      updatePreview();
    });
    label.append(radio);
    swatches.insertBefore(label, swatches.lastElementChild);
  }
}

/** Check the preset matching the chosen colour, or none for a custom colour. */
function syncSwatches(): void {
  const color = highlightColorInput.value.toLowerCase();
  for (const radio of swatches.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    radio.checked = radio.value === color;
  }
  const custom = highlightColorInput.closest('.swatch') as HTMLElement;
  const isPreset = HIGHLIGHT_PRESETS.some((p) => p.color === color);
  custom.style.boxShadow = isPreset ? '' : '0 0 0 2px var(--bg), 0 0 0 4px var(--accent)';
}

/** Show the chosen colours and style on the sample sentence, as the page will. */
function updatePreview(): void {
  const chunk = preview.querySelector('.preview__chunk') as HTMLElement;
  const color = highlightColorInput.value;
  const style = highlightStyleSelect.value as HighlightStyle;
  const word = preview.querySelector('.preview__word') as HTMLElement;
  chunk.style.cssText = '';
  word.style.cssText = wordHighlightInput.checked
    ? `background-color: ${wordColorInput.value}; color: #000;`
    : '';
  if (highContrastInput.checked) {
    chunk.style.cssText = 'background-color: #1b1b2a; color: #fff;';
    return;
  }
  if (style !== 'underline') chunk.style.backgroundColor = color;
  if (style !== 'background') {
    chunk.style.textDecoration = `underline 3px color-mix(in srgb, ${color} 55%, #000)`;
    chunk.style.textUnderlineOffset = '3px';
  }
}

// ---------------------------------------------------------------------------
// Test Sound
// ---------------------------------------------------------------------------

async function testSound(): Promise<void> {
  testFetch?.abort();
  testFetch = null;
  if (testAudio) {
    testAudio.pause();
    testAudio.onended = null;
    testAudio.onerror = null;
    testAudio.removeAttribute('src');
    testAudio.load();
    testAudio = null;
  }
  if (testAudioUrl) {
    URL.revokeObjectURL(testAudioUrl);
    testAudioUrl = null;
  }

  const controller = new AbortController();
  testFetch = controller;
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  // An empty voice is left out, so the server picks the default voice for the model.
  const voice = defaultVoiceSelect.value;
  const model = modelSelect.value || DEFAULT_MODEL;

  // Test message
  const testText = 'Hello! This is a test of the text-to-speech system.';

  // Show status
  testStatus.style.display = 'block';
  testStatus.textContent = 'Playing test sound...';
  testStatus.className = 'test-status test-status--playing';
  const slowTimer = setTimeout(() => {
    if (testFetch !== controller) return;
    testStatus.textContent = 'Loading model… the first use downloads it, which can take a while';
  }, SLOW_REQUEST_MS);

  try {
    // Fetch TTS audio directly from the server
    const url = `${serverUrl}/tts/generate`;
    const body: Record<string, string | number> = { text: testText };
    if (voice) body.voice = voice;
    if (model) body.model = model;
    const speed = Number(speedInput.value);
    if (speed !== 1) body.speed = speed;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const json = (await response.json().catch(() => ({}))) as { detail?: string };
      throw new Error(json.detail ?? `Server error ${response.status}`);
    }

    // Get the audio data as blob
    const audioBlob = await response.blob();
    clearTimeout(slowTimer);
    testStatus.textContent = 'Playing test sound...';
    if (controller.signal.aborted) return;
    const audioUrl = URL.createObjectURL(audioBlob);
    testAudioUrl = audioUrl;

    // Play the audio using HTML5 Audio
    const audio = new Audio(audioUrl);
    testAudio = audio;

    audio.onended = () => {
      if (testAudio !== audio) return;
      URL.revokeObjectURL(audioUrl);
      testAudioUrl = null;
      testAudio = null;
      testStatus.textContent = 'Test sound played successfully!';
      testStatus.className = 'test-status test-status--success';
      setTimeout(() => {
        testStatus.style.display = 'none';
      }, 3000);
    };

    audio.onerror = () => {
      if (testAudio !== audio) return;
      URL.revokeObjectURL(audioUrl);
      testAudioUrl = null;
      testAudio = null;
      testStatus.textContent = 'Error: Failed to play audio';
      testStatus.className = 'test-status test-status--error';
      setTimeout(() => {
        testStatus.style.display = 'none';
      }, 5000);
    };

    await audio.play();
  } catch (err) {
    if (controller.signal.aborted || testFetch !== controller) return;
    if (testAudio) {
      testAudio.pause();
      testAudio.onended = null;
      testAudio.onerror = null;
      testAudio.removeAttribute('src');
      testAudio.load();
      testAudio = null;
    }
    if (testAudioUrl) {
      URL.revokeObjectURL(testAudioUrl);
      testAudioUrl = null;
    }
    testStatus.textContent = `Error: ${(err as Error).message}`;
    testStatus.className = 'test-status test-status--error';
    setTimeout(() => {
      testStatus.style.display = 'none';
    }, 5000);
  } finally {
    clearTimeout(slowTimer);
    if (testFetch === controller) testFetch = null;
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/** List the extension's commands with the keys the browser has assigned to them. */
async function showShortcuts(): Promise<void> {
  const order = ['read-selection', 'read-page', 'toggle-pause', 'back', 'forward', 'stop'];
  const rank = (name?: string) => {
    const i = order.indexOf(name ?? '');
    return i === -1 ? order.length : i;
  };
  const commands = (await api.commands.getAll()).sort((a, b) => rank(a.name) - rank(b.name));
  shortcutList.innerHTML = '';
  for (const command of commands) {
    if (!command.description) continue; // the toolbar action's own entry
    const name = document.createElement('dt');
    name.textContent = command.description;
    const keys = document.createElement('dd');
    if (command.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = command.shortcut;
      keys.append(kbd);
    } else {
      keys.textContent = 'Not set';
    }
    shortcutList.append(name, keys);
  }
}

/** Open the browser's shortcut settings (Chrome, Edge; Firefox 137+ has an API for it). */
function openShortcutSettings(): void {
  const commands = api.commands as typeof api.commands & { openShortcutSettings?: () => void };
  if (commands.openShortcutSettings) {
    commands.openShortcutSettings();
  } else if (typeof browser !== 'undefined') {
    alert('Open about:addons, click the gear menu and choose Manage Extension Shortcuts.');
  } else {
    api.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }
}

// ---------------------------------------------------------------------------
// Save / Reset
// ---------------------------------------------------------------------------

async function saveSettings(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  const defaultVoice = defaultVoiceSelect.value || DEFAULT_VOICE;
  const selectedModel = modelSelect.value || DEFAULT_MODEL;

  await save({
    serverUrl,
    defaultVoice,
    selectedModel,
    speed: Number(speedInput.value),
    highlightColor: highlightColorInput.value,
    highlightStyle: highlightStyleSelect.value as HighlightStyle,
    highContrast: highContrastInput.checked,
    clickToRead: clickToReadInput.checked,
    wordHighlight: wordHighlightInput.checked,
    wordColor: wordColorInput.value,
  });

  saveMsg.textContent = 'Settings saved!';
  setTimeout(() => {
    saveMsg.textContent = '';
  }, 2500);
}

function resetSettings(): void {
  serverUrlInput.value = DEFAULT_SERVER_URL;
  populateModels([], DEFAULT_MODEL);
  setVoices([], DEFAULT_VOICE);
  showReadingSettings(DEFAULT_SETTINGS);
  setStatus('Reset to defaults. Click Save to apply.', 'idle');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

btnCheck.addEventListener('click', checkServer);
btnSave.addEventListener('click', saveSettings);
btnReset.addEventListener('click', resetSettings);
btnTestSound.addEventListener('click', testSound);
btnShortcuts.addEventListener('click', openShortcutSettings);
speedInput.addEventListener('input', () => {
  speedValue.textContent = formatSpeed(Number(speedInput.value));
});
renderSwatches();
highlightColorInput.addEventListener('input', () => {
  syncSwatches();
  updatePreview();
});
for (const input of [highlightStyleSelect, highContrastInput, wordHighlightInput, wordColorInput]) {
  input.addEventListener('input', updatePreview);
}

// Re-filter the default-voice list when the language/gender preselectors change
languageFilter.addEventListener('change', applyVoiceFilter);
genderFilter.addEventListener('change', applyVoiceFilter);

// When model changes, refresh voice list
modelSelect.addEventListener('change', async () => {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  await refreshVoices(serverUrl, modelSelect.value, '');
});

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  showShortcuts().catch(() => {});
});

export {};
