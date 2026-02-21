/**
 * Lyra TTS — Popup Script
 */

'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusBadge = document.getElementById('status-badge');
const voiceSelect = document.getElementById('voice-select');
const btnSelection = document.getElementById('btn-read-selection');
const btnPage = document.getElementById('btn-read-page');
const btnStop = document.getElementById('btn-stop');
const optionsLink = document.getElementById('options-link');

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  const { serverUrl, defaultVoice } = await getSettings();

  // Check server health
  const health = await sendBackground({ action: 'health', serverUrl });
  updateStatusBadge(health.available);

  // Load voices
  try {
    const { voices } = await sendBackground({ action: 'get-voices', serverUrl });
    populateVoices(voices, defaultVoice);
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

async function readSelection(serverUrl) {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  // Ask content script for selected text
  const response = await api.tabs.sendMessage(tab.id, { action: 'get-selection' });
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
  });
}

async function readPage(serverUrl) {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  // Extract visible text from the page
  const [result] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.body.innerText,
  });

  const text = result?.result?.trim();
  if (!text) return;

  setPlaying(true);
  await sendBackground({
    action: 'speak',
    text,
    voice: voiceSelect.value,
    serverUrl,
  });
}

async function stopPlayback() {
  setPlaying(false);
  await sendBackground({ action: 'stop' });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateStatusBadge(available) {
  if (available) {
    statusBadge.textContent = 'Online';
    statusBadge.className = 'badge badge--ok';
  } else {
    statusBadge.textContent = 'Server offline';
    statusBadge.className = 'badge badge--error';
  }
}

function populateVoices(voices, defaultVoice) {
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

function setPlaying(playing) {
  btnSelection.style.display = playing ? 'none' : '';
  btnPage.style.display = playing ? 'none' : '';
  btnStop.style.display = playing ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function getSettings() {
  return new Promise((resolve) => {
    api.storage.local.get({ serverUrl: 'http://127.0.0.1:8000', defaultVoice: 'leo' }, resolve);
  });
}

function sendBackground(message) {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, (response) => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
      } else {
        resolve(response ?? {});
      }
    });
  });
}

function getTabs() {
  return new Promise((resolve) => {
    api.tabs.query({ active: true, currentWindow: true }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);
