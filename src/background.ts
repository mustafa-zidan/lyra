// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lyra TTS - Background Service Worker
 *
 * Responsibilities:
 *  - Register the context-menu item
 *  - Split text into chunks and hand them to the tab's content script, which
 *    plays them in order (and asks for upcoming chunks while one plays)
 *  - Fetch audio for each chunk from the Lyra (Kokoro/MLX) server on request
 *  - Broadcast Stop to content scripts
 *
 * The read loop lives in the content script, not here: an MV3 service worker is
 * shut down after about 30 seconds without events, so a loop here that waited on a
 * long chunk's playback was killed partway through long pages. Each chunk the page
 * asks for is a fresh event, which keeps the worker alive (or wakes it) as needed.
 */

import { chunkText } from './chunk-text.js';

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
/** The first chunk is kept short so reading starts quickly. */
const FIRST_CHUNK_MAX = 180;
/** Later chunks are generated while the previous one plays, so they can be longer. */
const CHUNK_MAX = 450;

// ---------------------------------------------------------------------------
// Playback cancellation state
// ---------------------------------------------------------------------------

/**
 * The read each tab is currently on. A `generate` request carrying another read's id
 * is from a read that has since been replaced or stopped, so it is refused. This is
 * lost if the worker restarts, in which case every request is served.
 */
const activeReads = new Map<number, string>();
/** Reads that were stopped or replaced; their late `generate` requests are refused. */
const endedReads = new Set<string>();
/** In-flight chunk fetches per tab, so Stop (or a new read) can cancel them. */
const activeFetches = new Map<number, Set<AbortController>>();

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
  action: 'speak' | 'stop' | 'generate' | 'get-voices' | 'get-models' | 'health';
  text?: string;
  voice?: string;
  model?: string;
  serverUrl?: string;
  /** BCP-47 language of the text's page/element, used by the server to pick G2P + voice. */
  language?: string;
  /** For `generate`: the read the chunk belongs to. */
  readId?: string;
}

/** One chunk of generated speech, plus what the server actually used for it. */
interface TTSResult {
  audio: string;
  /** Model ID from `X-Model`; differs from the requested one when the server switched. */
  model: string | null;
  /** Language label from `X-Language`, e.g. "German". */
  language: string | null;
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
      { serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE, selectedModel: DEFAULT_MODEL },
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

    const { serverUrl, defaultVoice, selectedModel } = await getSettings();
    const selection = (await api!.tabs
      .sendMessage(tab.id, { action: 'get-selection' })
      .catch(() => undefined)) as { language?: string } | undefined;
    await speakInTab(tab.id, text, defaultVoice, serverUrl, selectedModel, selection?.language);
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
    const tabId = sender.tab?.id ?? (await getActiveTabId());
    if (!tabId) return { ok: false, error: 'No active tab' };

    const text = message.text?.trim();
    if (!text) return { ok: false, error: 'No text provided' };

    // The in-page selection button only sends `text`; fall back to the saved
    // settings for anything the caller (e.g. the popup) didn't specify.
    const settings = await getSettings();
    const voice = message.voice ?? settings.defaultVoice;
    const serverUrl = message.serverUrl ?? settings.serverUrl;
    const model = message.model ?? settings.selectedModel;

    speakInTab(tabId, text, voice, serverUrl, model, message.language).catch(console.error);
    return { ok: true };
  }

  if (action === 'stop') {
    // The tab that is reading may not be the one Stop came from (the popup, another
    // tab), and the worker may have restarted since the read began, so tell every tab.
    endAllReads();
    for (const tabId of await getAllTabIds()) notifyTab(tabId, { action: 'playback-stopped' });
    return { ok: true };
  }

  if (action === 'generate') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: false, error: 'No tab' };
    return generateChunk(tabId, message);
  }

  if (action === 'get-voices') {
    const { serverUrl, model } = message;
    const voices = await fetchVoices(serverUrl ?? DEFAULT_SERVER_URL, model);
    return { ok: true, voices };
  }

  if (action === 'get-models') {
    const { serverUrl } = message;
    const models = await fetchModels(serverUrl ?? DEFAULT_SERVER_URL);
    return { ok: true, models };
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
 * Start reading `text` aloud in a tab: split it into chunks and hand them to the
 * tab's content script, which highlights and plays them in order and requests the
 * audio for each (a few chunks ahead) through `generateChunk`.
 */
async function speakInTab(
  tabId: number,
  text: string,
  voice: string,
  serverUrl: string,
  model: string,
  language?: string,
): Promise<void> {
  // Only one read at a time: stop any other tab's read and drop stale fetches.
  for (const otherTabId of activeReads.keys()) {
    if (otherTabId !== tabId) notifyTab(otherTabId, { action: 'playback-stopped' });
  }
  endAllReads();

  // Chunks with nothing to say (e.g. a run of dashes) make the server fail; skip them.
  const chunks = chunkText(text, CHUNK_MAX, FIRST_CHUNK_MAX).filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (chunks.length === 0) {
    notifyTab(tabId, { action: 'playback-error', error: 'Nothing to read' });
    return;
  }

  const readId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeReads.set(tabId, readId);
  notifyTab(tabId, {
    action: 'start-reading',
    readId,
    chunks,
    voice,
    serverUrl,
    model,
    language,
  });
}

/**
 * Generate the audio for one chunk, on request from the content script reading it.
 * Returns the raw base64 WAV and the status-bar label for it.
 */
async function generateChunk(tabId: number, message: ExtMessage): Promise<Record<string, unknown>> {
  const {
    text,
    voice = '',
    serverUrl = DEFAULT_SERVER_URL,
    model = '',
    language,
    readId,
  } = message;
  if (!text) return { ok: false, error: 'No text provided' };
  const current = activeReads.get(tabId);
  if ((current !== undefined && current !== readId) || (readId && endedReads.has(readId))) {
    return { ok: false, cancelled: true };
  }
  if (current === undefined && readId) activeReads.set(tabId, readId); // worker restarted

  const controller = new AbortController();
  let fetches = activeFetches.get(tabId);
  if (!fetches) activeFetches.set(tabId, (fetches = new Set()));
  fetches.add(controller);
  try {
    const result = await fetchTTS(text, voice, serverUrl, model, language, controller.signal);
    const label = await describeResult(result, model, serverUrl);
    return { ok: true, audio: result.audio, label };
  } catch (err) {
    // A deliberate stop aborts the fetch — report it as cancelled, not as an error.
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: (err as Error).message };
  } finally {
    fetches.delete(controller);
    if (fetches.size === 0) activeFetches.delete(tabId);
  }
}

/** Mark every read as ended and abort their in-flight fetches. */
function endAllReads(): void {
  for (const readId of activeReads.values()) endedReads.add(readId);
  activeReads.clear();
  for (const tabId of activeFetches.keys()) abortFetches(tabId);
}

function abortFetches(tabId: number): void {
  for (const controller of activeFetches.get(tabId) ?? []) controller.abort();
  activeFetches.delete(tabId);
}

/** Model display names per server URL, for naming a model the server switched to. */
const modelNames = new Map<string, Map<string, string>>();

/**
 * Status-bar label for a generated chunk: the language, plus the model when the server
 * switched away from the requested one (e.g. "Reading aloud · German · Kokoro 82M German (Victoria)").
 */
async function describeResult(
  result: TTSResult,
  requestedModel: string,
  serverUrl: string,
): Promise<string> {
  const parts = ['Reading aloud'];
  if (result.language) parts.push(result.language);
  if (result.model && result.model !== requestedModel) {
    let names = modelNames.get(serverUrl);
    if (!names) {
      const models = await fetchModels(serverUrl).catch(() => [] as ModelInfo[]);
      names = new Map(models.map((m) => [m.id, m.name]));
      if (names.size) modelNames.set(serverUrl, names);
    }
    parts.push(names.get(result.model) ?? result.model.split('/').pop()!);
  }
  return parts.join(' · ');
}

/**
 * Fetch audio from the TTS server and return raw WAV bytes as a base64 string.
 * We intentionally do NOT produce a data: URL — pages with strict CSP (e.g. GitHub)
 * block data: URIs in media-src. The base64 payload is decoded in-page via the Web
 * Audio API (decodeAudioData) which operates on an ArrayBuffer and is not subject to
 * media-src CSP restrictions.
 *
 * An empty `voice` is left out, so the server picks the default voice for the model.
 */
async function fetchTTS(
  text: string,
  voice: string,
  serverUrl: string,
  model: string,
  language: string | undefined,
  signal?: AbortSignal,
): Promise<TTSResult> {
  const url = `${serverUrl}/tts/generate`;
  const body: Record<string, string> = { text };
  if (voice) body.voice = voice;
  if (model) body.model = model;
  if (language) body.language = language;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(json.detail ?? `Server error ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  // Build the binary string in slices: one call per byte is slow for long chunks'
  // audio, and one call for everything overflows the argument limit.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    audio: btoa(binary), // raw base64, no data: prefix
    model: response.headers.get('X-Model'),
    language: response.headers.get('X-Language'),
  };
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
    return { available: data.tts_available, status: data.status };
  } catch {
    return { available: false, status: 'unreachable' };
  }
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

function notifyTab(tabId: number, payload: Record<string, unknown>): void {
  api!.tabs.sendMessage(tabId, payload).catch(() => {
    // Tab may not have content script — safe to ignore
  });
}

async function getAllTabIds(): Promise<number[]> {
  const tabs = await api!.tabs.query({});
  return tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
}

async function getActiveTabId(): Promise<number | null> {
  return new Promise((resolve) => {
    api!.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id ?? null);
    });
  });
}

export {};
