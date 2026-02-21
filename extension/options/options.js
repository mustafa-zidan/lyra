/**
 * Lyra TTS — Options Page Script
 */

'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'leo';
const KNOWN_VOICES = ['tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const serverUrlInput = document.getElementById('server-url');
const defaultVoiceSelect = document.getElementById('default-voice');
const btnCheck = document.getElementById('btn-check');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');
const serverStatus = document.getElementById('server-status');
const saveMsg = document.getElementById('save-msg');

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const { serverUrl, defaultVoice } = await getSettings();
  serverUrlInput.value = serverUrl;
  populateVoices(KNOWN_VOICES, defaultVoice);

  // Try loading voices from server for fresh list
  try {
    const response = await api.runtime.sendMessage({
      action: 'get-voices',
      serverUrl,
    });
    if (response?.voices?.length) {
      populateVoices(
        response.voices.map((v) => v.id),
        defaultVoice,
      );
    }
  } catch {
    // Server may be offline; use static list
  }
}

// ---------------------------------------------------------------------------
// Check server connectivity
// ---------------------------------------------------------------------------

async function checkServer() {
  const url = serverUrlInput.value.trim();
  if (!url) {
    setStatus('Enter a server URL first.', 'error');
    return;
  }

  setStatus('Checking…', 'idle');
  try {
    const response = await api.runtime.sendMessage({ action: 'health', serverUrl: url });
    if (response.available) {
      setStatus(`Connected ✓  (provider: ${response.status ?? 'ok'})`, 'ok');
      // Refresh voice list from live server
      const vResp = await api.runtime.sendMessage({ action: 'get-voices', serverUrl: url });
      if (vResp?.voices?.length) {
        const current = defaultVoiceSelect.value;
        populateVoices(
          vResp.voices.map((v) => v.id),
          current,
        );
      }
    } else {
      setStatus('Server reachable but TTS backend offline.', 'error');
    }
  } catch (err) {
    setStatus(`Cannot reach server: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Save / Reset
// ---------------------------------------------------------------------------

async function saveSettings() {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  const defaultVoice = defaultVoiceSelect.value || DEFAULT_VOICE;

  await new Promise((resolve) => {
    api.storage.local.set({ serverUrl, defaultVoice }, resolve);
  });

  saveMsg.textContent = 'Settings saved!';
  setTimeout(() => {
    saveMsg.textContent = '';
  }, 2500);
}

function resetSettings() {
  serverUrlInput.value = DEFAULT_SERVER_URL;
  populateVoices(KNOWN_VOICES, DEFAULT_VOICE);
  setStatus('Reset to defaults. Click Save to apply.', 'idle');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function populateVoices(voiceIds, selectedId) {
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

function setStatus(message, type) {
  serverStatus.textContent = message;
  serverStatus.className = `server-status server-status--${type}`;
}

async function getSettings() {
  return new Promise((resolve) => {
    api.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

btnCheck.addEventListener('click', checkServer);
btnSave.addEventListener('click', saveSettings);
btnReset.addEventListener('click', resetSettings);

document.addEventListener('DOMContentLoaded', loadSettings);
