// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lyra TTS - Background Service Worker
 *
 * Responsibilities:
 *  - Register the context-menu item
 *  - Fetch audio from the Eurydice server
 *  - Play audio injected into the active tab
 *  - Broadcast playback state and chunk highlights to content scripts
 */

// Cross-browser API shim (Firefox uses `browser`, Chrome uses `chrome`).
// Both are declared as globals in eslint.config.js no import needed.
const api: typeof chrome | null =
  typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'leo';
const CONTEXT_MENU_ID = 'lyra-read-selection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Settings {
  serverUrl: string;
  defaultVoice: string;
}

interface Voice {
  id: string;
  name: string;
  default?: boolean;
}

interface ExtMessage {
  action: 'speak' | 'stop' | 'get-voices' | 'health';
  text?: string;
  voice?: string;
  serverUrl?: string;
}

interface HealthStatus {
  available: boolean;
  status: string;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    api!.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE }, (items) => {
      resolve(items as unknown as Settings);
    });
  });
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

if (api) {
  api.runtime.onInstalled.addListener(() => {
    api!.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Read selection aloud with Lyra',
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
    handleMessage(message as ExtMessage, sender)
      .then(sendResponse)
      .catch((err: Error) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep channel open for async response
  });
}

async function handleMessage(
  message: ExtMessage,
  sender: chrome.runtime.MessageSender,
): Promise<Record<string, unknown>> {
  const { action } = message;

  if (action === 'speak') {
    const { text, voice, serverUrl } = message;
    const tabId = sender.tab?.id ?? (await getActiveTabId());
    if (!tabId) return { ok: false, error: 'No active tab' };

    speakInTab(tabId, text!, voice!, serverUrl!).catch(console.error);
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
 * Generate speech for each chunk of text, highlighting and playing sequentially.
 */
async function speakInTab(
  tabId: number,
  text: string,
  voice: string,
  serverUrl: string,
): Promise<void> {
  notifyTab(tabId, { action: 'playback-started', text });

  try {
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      // Signal content script to highlight this chunk before fetching audio
      notifyTab(tabId, { action: 'chunk-highlight', text: chunk });

      const audioBase64 = await fetchTTS(chunk, voice, serverUrl);
      await api!.scripting.executeScript({
        target: { tabId },
        func: playAudioInPage,
        args: [audioBase64],
      });
    }
    // Clear highlight after all chunks finish
    notifyTab(tabId, { action: 'chunk-highlight', text: null });
    notifyTab(tabId, { action: 'playback-finished' });
  } catch (err) {
    notifyTab(tabId, { action: 'chunk-highlight', text: null });
    notifyTab(tabId, { action: 'playback-error', error: (err as Error).message });
  }
}

/**
 * Fetch audio from the TTS server and return it as a base64 data URL.
 */
async function fetchTTS(text: string, voice: string, serverUrl: string): Promise<string> {
  const url = `${serverUrl}/tts/generate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || DEFAULT_VOICE }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
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
async function fetchVoices(serverUrl: string): Promise<Voice[]> {
  const response = await fetch(`${serverUrl}/voices`);
  if (!response.ok) throw new Error(`Voices request failed: ${response.status}`);
  const data = await response.json() as { voices?: Voice[] };
  return data.voices ?? [];
}

/**
 * Fetch server health status.
 */
async function fetchHealth(serverUrl: string): Promise<HealthStatus> {
  try {
    const response = await fetch(`${serverUrl}/health`);
    const data = await response.json() as { tts_available: boolean; status: string };
    return { available: data.tts_available, status: data.status };
  } catch {
    return { available: false, status: 'unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split text at sentence boundaries into chunks of at most `maxLen` characters.
 */
function chunkText(text: string, maxLen = 500): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  const chunks: string[] = [];
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

function notifyTab(tabId: number, payload: Record<string, unknown>): void {
  api!.tabs.sendMessage(tabId, payload).catch(() => {
    // Tab may not have content script — safe to ignore
  });
}

async function getActiveTabId(): Promise<number | null> {
  return new Promise((resolve) => {
    api!.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

// ---------------------------------------------------------------------------
// Injected function — runs inside the page context
// ---------------------------------------------------------------------------

/**
 * Plays a base64-encoded WAV in the page.
 * Serialised and injected via scripting.executeScript — must be self-contained.
 */
function playAudioInPage(audioDataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(audioDataUrl);
    audio.onended = () => resolve();
    audio.onerror = (e) => reject(new Error(`Audio playback error: ${(e as ErrorEvent).message}`));
    audio.play().catch(reject);
  });
}

export {};
