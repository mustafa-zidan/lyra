/**
 * Lyra TTS: Popup Script
 */

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusBadge = document.getElementById('status-badge') as HTMLElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;
const btnSelection = document.getElementById('btn-read-selection') as HTMLButtonElement;
const btnPage = document.getElementById('btn-read-page') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const optionsLink = document.getElementById('options-link') as HTMLAnchorElement;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Voice {
  id: string;
  name: string;
  default?: boolean;
}

interface Settings {
  serverUrl: string;
  defaultVoice: string;
}

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
  const { serverUrl, defaultVoice } = await getSettings();

  // Check server health
  const health = await sendBackground({ action: 'health', serverUrl });
  updateStatusBadge(health.available ?? false);

  // Load voices
  try {
    const { voices } = await sendBackground({ action: 'get-voices', serverUrl });
    populateVoices(voices ?? [], defaultVoice);
    btnSelection.disabled = false;
    btnPage.disabled = false;
  } catch {
    populateVoices([], defaultVoice);
  }

  // Options link
  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
  });

  // Button handlers
  btnSelection.addEventListener('click', () => readSelection(serverUrl));
  btnPage.addEventListener('click', () => readPage(serverUrl));
  btnStop.addEventListener('click', stopPlayback);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function readSelection(serverUrl: string): Promise<void> {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  const response = await api.tabs.sendMessage(tab.id, { action: 'get-selection' }) as { text?: string } | undefined;
  const text = response?.text?.trim();
  if (!text) {
    statusBadge.textContent = 'No text selected';
    statusBadge.className = 'badge badge--error';
    return;
  }

  setPlaying(true);
  await sendBackground({ action: 'speak', text, voice: voiceSelect.value, serverUrl });
}

async function readPage(serverUrl: string): Promise<void> {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  const [result] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.body.innerText,
  });

  const text = (result?.result as string | undefined)?.trim();
  if (!text) return;

  setPlaying(true);
  await sendBackground({ action: 'speak', text, voice: voiceSelect.value, serverUrl });
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

function populateVoices(voices: Voice[], defaultVoice: string): void {
  voiceSelect.innerHTML = '';
  if (voices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Default';
    voiceSelect.appendChild(opt);
    return;
  }
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    if (v.id === defaultVoice || v.default) opt.selected = true;
    voiceSelect.appendChild(opt);
  }
}

function setPlaying(playing: boolean): void {
  btnSelection.style.display = playing ? 'none' : '';
  btnPage.style.display = playing ? 'none' : '';
  btnStop.style.display = playing ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    api.storage.local.get({ serverUrl: 'http://127.0.0.1:8000', defaultVoice: 'leo' }, (items) => {
      resolve(items as unknown as Settings);
    });
  });
}

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
