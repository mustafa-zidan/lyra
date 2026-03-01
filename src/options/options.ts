/**
 * Lyra TTS: Options Page Script
 */

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'leo';
const KNOWN_VOICES = ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const defaultVoiceSelect = document.getElementById('default-voice') as HTMLSelectElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const serverStatus = document.getElementById('server-status') as HTMLElement;
const saveMsg = document.getElementById('save-msg') as HTMLElement;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Voice {
  id: string;
  name: string;
}

interface Settings {
  serverUrl: string;
  defaultVoice: string;
}

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const { serverUrl, defaultVoice } = await getSettings();
  serverUrlInput.value = serverUrl;
  populateVoices(KNOWN_VOICES, defaultVoice);

  try {
    const response = await api.runtime.sendMessage({ action: 'get-voices', serverUrl }) as { voices?: Voice[] } | undefined;
    if (response?.voices?.length) {
      populateVoices(response.voices.map((v) => v.id), defaultVoice);
    }
  } catch {
    // Server may be offline; use static list
  }
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
    const response = await api.runtime.sendMessage({ action: 'health', serverUrl: url }) as { available?: boolean; status?: string } | undefined;
    if (response?.available) {
      setStatus(`Connected ✓  (provider: ${response.status ?? 'ok'})`, 'ok');
      const vResp = await api.runtime.sendMessage({ action: 'get-voices', serverUrl: url }) as { voices?: Voice[] } | undefined;
      if (vResp?.voices?.length) {
        populateVoices(vResp.voices.map((v) => v.id), defaultVoiceSelect.value);
      }
    } else {
      setStatus('Server reachable but TTS backend offline.', 'error');
    }
  } catch (err) {
    setStatus(`Cannot reach server: ${(err as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Save / Reset
// ---------------------------------------------------------------------------

async function saveSettings(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  const defaultVoice = defaultVoiceSelect.value || DEFAULT_VOICE;

  await new Promise<void>((resolve) => {
    api.storage.local.set({ serverUrl, defaultVoice }, resolve);
  });

  saveMsg.textContent = 'Settings saved!';
  setTimeout(() => {
    saveMsg.textContent = '';
  }, 2500);
}

function resetSettings(): void {
  serverUrlInput.value = DEFAULT_SERVER_URL;
  populateVoices(KNOWN_VOICES, DEFAULT_VOICE);
  setStatus('Reset to defaults. Click Save to apply.', 'idle');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function populateVoices(voiceIds: string[], selectedId: string): void {
  const current = defaultVoiceSelect.value;
  defaultVoiceSelect.innerHTML = '';
  for (const id of voiceIds) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id.charAt(0).toUpperCase() + id.slice(1);
    defaultVoiceSelect.appendChild(opt);
  }
  defaultVoiceSelect.value = selectedId || current || DEFAULT_VOICE;
}

function setStatus(message: string, type: 'idle' | 'ok' | 'error'): void {
  serverStatus.textContent = message;
  serverStatus.className = `server-status server-status--${type}`;
}

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    api.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE }, (items) => {
      resolve(items as unknown as Settings);
    });
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

btnCheck.addEventListener('click', checkServer);
btnSave.addEventListener('click', saveSettings);
btnReset.addEventListener('click', resetSettings);

document.addEventListener('DOMContentLoaded', loadSettings);

export {};
