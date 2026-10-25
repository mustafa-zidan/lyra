// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lyra TTS - Background Service Worker
 *
 * Responsibilities:
 *  - Register the context-menu item
 *  - Fetch audio from the Lyra (Kokoro/MLX) server
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
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_MODEL = 'mlx-community/Kokoro-82M-bf16';
const CONTEXT_MENU_ID = 'lyra-read-selection';

// ---------------------------------------------------------------------------
// Playback cancellation state
// ---------------------------------------------------------------------------

/**
 * Monotonic id for the active read. Each call to speakInTab claims the next id;
 * a running loop bails the moment `playbackSession` moves past its own id, so
 * pressing Stop (which bumps the id) or starting a new read cancels the old one.
 */
let playbackSession = 0;
/** Tab that owns the current read, used when Stop is clicked from another tab. */
let playbackTabId: number | null = null;
/** AbortController for the in-flight chunk fetch, so Stop can cancel mid-request. */
let activeFetch: AbortController | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Settings {
  serverUrl: string;
  defaultVoice: string;
  selectedModel: string;
}

interface Voice {
  id: string;
  name: string;
  default?: boolean;
}

interface ModelInfo {
  id: string;
  name: string;
  description: string;
  languages: string[];
  default: boolean;
}

interface ExtMessage {
  action: 'speak' | 'stop' | 'get-voices' | 'get-models' | 'health';
  text?: string;
  voice?: string;
  model?: string;
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
    api!.storage.local.get(
        {serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE, selectedModel: DEFAULT_MODEL},
        (items) => {
          resolve(items as unknown as Settings);
        },
    );
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

    const {serverUrl, defaultVoice, selectedModel} = await getSettings();
    await speakInTab(tab.id, text, defaultVoice, serverUrl, selectedModel);
  });

  // ---------------------------------------------------------------------------
  // Message handling (from popup / content script)
  // ---------------------------------------------------------------------------

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message as ExtMessage, sender)
        .then(sendResponse)
        .catch((err: Error) => {
          sendResponse({ok: false, error: err.message});
        });
    return true; // keep channel open for async response
  });
}

async function handleMessage(
    message: ExtMessage,
    sender: chrome.runtime.MessageSender,
): Promise<Record<string, unknown>> {
  const {action} = message;

  if (action === 'speak') {
    const tabId = sender.tab?.id ?? (await getActiveTabId());
    if (!tabId) return {ok: false, error: 'No active tab'};

    const text = message.text?.trim();
    if (!text) return {ok: false, error: 'No text provided'};

    // The in-page selection button only sends `text`; fall back to the saved
    // settings for anything the caller (e.g. the popup) didn't specify.
    const settings = await getSettings();
    const voice = message.voice ?? settings.defaultVoice;
    const serverUrl = message.serverUrl ?? settings.serverUrl;
    const model = message.model ?? settings.selectedModel;

    speakInTab(tabId, text, voice, serverUrl, model).catch(console.error);
    return {ok: true};
  }

  if (action === 'stop') {
    // Invalidate any running read loop and abort an in-flight fetch.
    playbackSession++;
    const readingTabId = playbackTabId;
    playbackTabId = null;
    activeFetch?.abort();
    activeFetch = null;

    const tabId = sender.tab?.id ?? (await getActiveTabId());
    const tabsToStop = new Set<number>();
    if (readingTabId !== null) tabsToStop.add(readingTabId);
    if (tabId !== null) tabsToStop.add(tabId);
    for (const targetTabId of tabsToStop) {
      await stopAudioInTab(targetTabId); // halt audio already playing in the page
      notifyTab(targetTabId, {action: 'playback-stopped'});
    }
    return {ok: true};
  }

  if (action === 'get-voices') {
    const {serverUrl, model} = message;
    const voices = await fetchVoices(serverUrl ?? DEFAULT_SERVER_URL, model);
    return {ok: true, voices};
  }

  if (action === 'get-models') {
    const {serverUrl} = message;
    const models = await fetchModels(serverUrl ?? DEFAULT_SERVER_URL);
    return {ok: true, models};
  }

  if (action === 'health') {
    const {serverUrl} = message;
    const status = await fetchHealth(serverUrl ?? DEFAULT_SERVER_URL);
    return {ok: true, ...status};
  }

  return {ok: false, error: `Unknown action: ${action}`};
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
    model: string,
): Promise<void> {
  // Claim this read; any older loop will see playbackSession move past its id.
  const session = ++playbackSession;
  const previousTabId = playbackTabId;
  playbackTabId = tabId;
  activeFetch?.abort();
  activeFetch = null;
  if (previousTabId !== null && previousTabId !== tabId) {
    await stopAudioInTab(previousTabId);
    notifyTab(previousTabId, {action: 'playback-stopped'});
  }
  await stopAudioInTab(tabId); // stop audio lingering from a previous read
  if (session !== playbackSession) return;

  notifyTab(tabId, {action: 'playback-started', text});

  try {
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      if (session !== playbackSession) return; // stopped or superseded

      // Signal content script to highlight this chunk before fetching audio
      notifyTab(tabId, {action: 'chunk-highlight', text: chunk});

      const controller = new AbortController();
      activeFetch = controller;
      let audioBase64: string;
      try {
        audioBase64 = await fetchTTS(chunk, voice, serverUrl, model, controller.signal);
      } catch (err) {
        // A deliberate stop aborts the fetch — swallow it, don't show an error.
        if (controller.signal.aborted || session !== playbackSession) return;
        throw err;
      } finally {
        if (activeFetch === controller) activeFetch = null;
      }

      if (session !== playbackSession) return; // stopped while fetching
      await playAudioInTab(tabId, audioBase64);
      if (session !== playbackSession) return; // stopped during playback
    }
    // Clear highlight after all chunks finish
    notifyTab(tabId, {action: 'chunk-highlight', text: null});
    notifyTab(tabId, {action: 'playback-finished'});
  } catch (err) {
    notifyTab(tabId, {action: 'chunk-highlight', text: null});
    notifyTab(tabId, {action: 'playback-error', error: (err as Error).message});
  } finally {
    if (session === playbackSession && playbackTabId === tabId) playbackTabId = null;
  }
}

/**
 * Fetch audio from the TTS server and return raw WAV bytes as a base64 string.
 * We intentionally do NOT produce a data: URL — pages with strict CSP (e.g. GitHub)
 * block data: URIs in media-src. The base64 payload is decoded in-page via the Web
 * Audio API (decodeAudioData) which operates on an ArrayBuffer and is not subject to
 * media-src CSP restrictions.
 */
async function fetchTTS(
    text: string,
    voice: string,
    serverUrl: string,
    model: string,
    signal?: AbortSignal,
): Promise<string> {
  const url = `${serverUrl}/tts/generate`;
  const body: Record<string, string> = {text, voice: voice || DEFAULT_VOICE};
  if (model) body.model = model;

  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(json.detail ?? `Server error ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary); // raw base64, no data: prefix
}

/**
 * Fetch the list of available voices from the server for a given model.
 */
async function fetchVoices(serverUrl: string, model?: string): Promise<Voice[]> {
  const url = new URL(`${serverUrl}/voices`);
  if (model) url.searchParams.set('model', model);
  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`Voices request failed: ${response.status}`);
  const data = (await response.json()) as { voices?: Voice[] };
  return data.voices ?? [];
}

/**
 * Fetch the list of available models from the server.
 */
async function fetchModels(serverUrl: string): Promise<ModelInfo[]> {
  const response = await fetch(`${serverUrl}/models`);
  if (!response.ok) throw new Error(`Models request failed: ${response.status}`);
  const data = (await response.json()) as { models?: ModelInfo[] };
  return data.models ?? [];
}

/**
 * Fetch server health status.
 */
async function fetchHealth(serverUrl: string): Promise<HealthStatus> {
  try {
    const response = await fetch(`${serverUrl}/health`);
    const data = (await response.json()) as { tts_available: boolean; status: string };
    return {available: data.tts_available, status: data.status};
  } catch {
    return {available: false, status: 'unreachable'};
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
    api!.tabs.query({active: true, currentWindow: true}, (tabs) => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

// ---------------------------------------------------------------------------
// Audio playback (delegated to the content script)
// ---------------------------------------------------------------------------

/**
 * Hand a chunk of base64-encoded WAV audio to the content script and wait until
 * it finishes playing.
 *
 * Playback happens inside the already-injected content script (via the Web
 * Audio API) rather than through scripting.executeScript. The content script
 * matches every http/https page, so this works without host permissions or an
 * activeTab grant — which matters because the in-page selection button is not a
 * gesture that grants activeTab the way clicking the toolbar action is.
 *
 * decodeAudioData on an ArrayBuffer also sidesteps the page's media-src CSP, the
 * same reason fetchTTS returns raw base64 rather than a data: URL.
 */
async function playAudioInTab(tabId: number, audioBase64: string): Promise<void> {
  try {
    await api!.tabs.sendMessage(tabId, {action: 'play-audio', audio: audioBase64});
  } catch {
    // Tab closed or no content script present — safe to ignore.
  }
}

/** Tell the content script to halt any audio currently playing in the tab. */
async function stopAudioInTab(tabId: number): Promise<void> {
  notifyTab(tabId, {action: 'stop-audio'});
}

export {};
