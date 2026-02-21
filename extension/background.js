/**
 * Lyra TTS — Background Service Worker
 *
 * Responsibilities:
 *  - Register the context-menu item
 *  - Fetch audio from the Eurydice server
 *  - Play audio in a background AudioContext
 *  - Broadcast playback state to content scripts
 */

'use strict';

// Cross-browser API shim (Firefox uses `browser`, Chrome uses `chrome`)
const api = typeof browser !== 'undefined' ? browser : chrome;

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'leo';
const CONTEXT_MENU_ID = 'lyra-read-selection';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getSettings() {
  return new Promise((resolve) => {
    api.storage.local.get(
      { serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE },
      resolve,
    );
  });
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Read selection aloud — Lyra',
    contexts: ['selection'],
  });
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = info.selectionText?.trim();
  if (!text || !tab?.id) return;

  const { serverUrl, defaultVoice } = await getSettings();
  await speakInTab(tab.id, text, defaultVoice, serverUrl);
});

// ---------------------------------------------------------------------------
// Message handling (from popup / content script)
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  const { action } = message;

  if (action === 'speak') {
    const { text, voice, serverUrl } = message;
    const tabId = sender.tab?.id ?? (await getActiveTabId());
    if (!tabId) return { ok: false, error: 'No active tab' };

    // Run async without awaiting so the response comes back immediately
    speakInTab(tabId, text, voice, serverUrl).catch(console.error);
    return { ok: true };
  }

  if (action === 'stop') {
    const tabId = sender.tab?.id ?? (await getActiveTabId());
    if (tabId) notifyTab(tabId, { action: 'playback-stopped' });
    return { ok: true };
  }

  if (action === 'get-voices') {
    const { serverUrl } = message;
    const voices = await fetchVoices(serverUrl ?? DEFAULT_SERVER_URL);
    return { ok: true, voices };
  }

  if (action === 'health') {
    const { serverUrl } = message;
    const status = await fetchHealth(serverUrl ?? DEFAULT_SERVER_URL);
    return { ok: true, ...status };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

// ---------------------------------------------------------------------------
// TTS core
// ---------------------------------------------------------------------------

/**
 * Send text-to-speech request to the server, then play the returned WAV in
 * the target tab via an injected script.
 */
async function speakInTab(tabId, text, voice, serverUrl) {
  notifyTab(tabId, { action: 'playback-started', text });

  try {
    // Split long text into sentence-sized chunks for lower latency
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const audioBase64 = await fetchTTS(chunk, voice, serverUrl);
      // Inject the audio player script into the tab
      await api.scripting.executeScript({
        target: { tabId },
        func: playAudioInPage,
        args: [audioBase64],
      });
    }
    notifyTab(tabId, { action: 'playback-finished' });
  } catch (err) {
    notifyTab(tabId, { action: 'playback-error', error: err.message });
  }
}

/**
 * Fetch audio from the TTS server and return it as a base64 data URL.
 */
async function fetchTTS(text, voice, serverUrl) {
  const url = `${serverUrl}/tts/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || DEFAULT_VOICE }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail ?? `Server error ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/**
 * Fetch the list of available voices from the server.
 */
async function fetchVoices(serverUrl) {
  const response = await fetch(`${serverUrl}/voices`);
  if (!response.ok) throw new Error(`Voices request failed: ${response.status}`);
  const data = await response.json();
  return data.voices ?? [];
}

/**
 * Fetch server health status.
 */
async function fetchHealth(serverUrl) {
  try {
    const response = await fetch(`${serverUrl}/health`);
    const data = await response.json();
    return { available: data.tts_available, status: data.status };
  } catch {
    return { available: false, status: 'unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split text at sentence boundaries into chunks of ~500 characters.
 */
function chunkText(text, maxLen = 500) {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length > maxLen && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

function notifyTab(tabId, payload) {
  api.tabs.sendMessage(tabId, payload).catch(() => {
    // Tab may not have content script — safe to ignore
  });
}

async function getActiveTabId() {
  return new Promise((resolve) => {
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

// ---------------------------------------------------------------------------
// Injected function — runs inside the page context
// ---------------------------------------------------------------------------

/**
 * Plays a base64-encoded WAV in the page.
 * This function is serialised and injected via scripting.executeScript.
 */
function playAudioInPage(audioDataUrl) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(audioDataUrl);
    audio.onended = resolve;
    audio.onerror = (e) => reject(new Error(`Audio playback error: ${e.message}`));
    audio.play().catch(reject);
  });
}
