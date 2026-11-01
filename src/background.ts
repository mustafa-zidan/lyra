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
import { DEFAULT_SETTINGS, getSettings, MAX_SPEED, MIN_SPEED } from './settings.js';

// Cross-browser API shim (Firefox uses `browser`, Chrome uses `chrome`).
// Both are declared as globals in eslint.config.js no import needed.
const api: typeof chrome | null =
  typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = DEFAULT_SETTINGS.serverUrl;
const CONTEXT_MENU_ID = 'lyra-read-selection';
const READ_FROM_HERE_MENU_ID = 'lyra-read-from-here';
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

type PlaybackCommand = 'toggle-pause' | 'back' | 'forward';

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
  action:
    | 'speak'
    | 'read-page'
    | 'read-from-here'
    | 'stop'
    | 'command'
    | 'generate'
    | 'get-voices'
    | 'get-models'
    | 'health';
  /** For `command`: a keyboard-shortcut command name (see the manifest), e.g. `toggle-pause`. */
  command?: string;
  text?: string;
  voice?: string;
  model?: string;
  serverUrl?: string;
  /** BCP-47 language of the text's page/element, used by the server to pick G2P + voice. */
  language?: string;
  /** For `read-from-here`: the clicked block's text, to find it in the article. */
  anchor?: string;
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
  /** From `X-Word-Timings`: [start, end, startSeconds, endSeconds] per spoken word. */
  words: number[][];
}

interface HealthStatus {
  available: boolean;
  status: string;
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
    api!.contextMenus.create({
      id: READ_FROM_HERE_MENU_ID,
      title: 'Read aloud from here',
      contexts: ['page'],
    });
  });

  api.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === READ_FROM_HERE_MENU_ID && tab?.id) {
      const here = (await api!.tabs
        .sendMessage(tab.id, { action: 'get-text-from-here' })
        .catch(() => null)) as TextFromHere | null;
      if (here) await readFromHere(tab.id, here);
      return;
    }
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    const text = info.selectionText?.trim();
    if (!text || !tab?.id) return;

    const { serverUrl, defaultVoice, selectedModel } = await getSettings();
    const selection = (await api!.tabs
      .sendMessage(tab.id, { action: 'get-selection' })
      .catch(() => undefined)) as { language?: string } | undefined;
    await speakInTab(tab.id, text, defaultVoice, serverUrl, selectedModel, selection?.language);
  });

  // Keyboard shortcuts (manifest `commands`; users can change the keys in the browser).
  api.commands.onCommand.addListener((command, tab) => {
    runCommand(command, tab?.id).catch(console.error);
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

  if (action === 'read-page') {
    const tabId = await getActiveTabId();
    if (!tabId) return { ok: false, error: 'No active tab' };
    return readPage(tabId, message.voice);
  }

  if (action === 'read-from-here') {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !message.text) return { ok: false, error: 'No text provided' };
    await readFromHere(tabId, {
      anchor: message.anchor ?? '',
      text: message.text,
      language: message.language,
    });
    return { ok: true };
  }

  if (action === 'stop') {
    // The tab that is reading may not be the one Stop came from (the popup, another
    // tab), and the worker may have restarted since the read began, so tell every tab.
    endAllReads();
    for (const tabId of await getAllTabIds()) notifyTab(tabId, { action: 'playback-stopped' });
    return { ok: true };
  }

  if (action === 'command') {
    // The popup's playback buttons run the same commands as the keyboard shortcuts,
    // on the active tab.
    if (message.command) await runCommand(message.command);
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

/** Run a keyboard shortcut. `tabId` is the active tab when the shortcut was pressed. */
async function runCommand(command: string, tabId?: number): Promise<void> {
  tabId ??= (await getActiveTabId()) ?? undefined;
  switch (command) {
    case 'read-selection': {
      if (tabId === undefined) return;
      const selection = (await api!.tabs
        .sendMessage(tabId, { action: 'get-selection' })
        .catch(() => undefined)) as { text?: string; language?: string } | undefined;
      const text = selection?.text?.trim();
      if (!text) {
        notifyTab(tabId, { action: 'playback-error', error: 'Select some text first' });
        return;
      }
      const { serverUrl, defaultVoice, selectedModel } = await getSettings();
      await speakInTab(tabId, text, defaultVoice, serverUrl, selectedModel, selection?.language);
      return;
    }
    case 'read-page':
      if (tabId !== undefined) await readPage(tabId);
      return;
    case 'stop':
      await handleMessage({ action: 'stop' }, {});
      return;
    case 'toggle-pause':
    case 'back':
    case 'forward':
      await controlPlayback(command);
      return;
  }
}

/**
 * Read a tab's article aloud: the Readability extraction, else its `article`/`main`
 * element, else all of the body's text. `voice` defaults to the saved default voice.
 */
async function readPage(tabId: number, voice?: string): Promise<Record<string, unknown>> {
  const page = await extractPage(tabId).catch(() => null);
  const text = page?.text?.trim();
  if (!text) {
    notifyTab(tabId, { action: 'playback-error', error: 'No readable text on this page' });
    return { ok: false, error: 'No readable text on this page' };
  }
  const { serverUrl, defaultVoice, selectedModel } = await getSettings();
  await speakInTab(tabId, text, voice || defaultVoice, serverUrl, selectedModel, page?.language);
  return { ok: true };
}

/** A clicked point of a page, from the content script. */
interface TextFromHere {
  anchor: string;
  /** The page's own text from the clicked block on, used if the article doesn't have it. */
  text: string;
  language?: string;
}

/**
 * Read from a clicked block to the end of the article. Uses the Readability article
 * (as Read page does) from the block on, so navigation and sidebars after it are left
 * out; falls back to the page's own text when the block isn't in the article (or
 * extraction fails).
 */
async function readFromHere(tabId: number, here: TextFromHere): Promise<void> {
  let text = here.text;
  let language = here.language;
  const page = await extractPage(tabId).catch(() => null);
  const at = page?.text ? findLoosely(page.text, here.anchor) : -1;
  if (at !== -1) {
    text = page!.text!.slice(at);
    language ??= page!.language;
  }
  const { serverUrl, defaultVoice, selectedModel } = await getSettings();
  await speakInTab(tabId, text, defaultVoice, serverUrl, selectedModel, language);
}

/**
 * Index of `needle`'s first 12 words in `haystack`, ignoring how whitespace differs
 * (Readability and innerText break lines differently), or -1.
 */
function findLoosely(haystack: string, needle: string): number {
  const words = needle.trim().split(/\s+/).slice(0, 12);
  if (!words[0]) return -1;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return haystack.search(new RegExp(pattern));
}

async function extractPage(tabId: number): Promise<{ text?: string; language?: string } | null> {
  // Inject Readability.js into the page's content-script world
  await api!.scripting.executeScript({
    target: { tabId },
    files: ['/vendor/Readability.js'],
  });

  const [result] = await api!.scripting.executeScript({
    target: { tabId },
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
  return (result?.result as { text?: string; language?: string } | undefined) ?? null;
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

  // Read per chunk, so a speed change in the popup applies from the next chunk on.
  const { speed } = await getSettings();
  const controller = new AbortController();
  let fetches = activeFetches.get(tabId);
  if (!fetches) activeFetches.set(tabId, (fetches = new Set()));
  fetches.add(controller);
  try {
    const result = await fetchTTS(
      text,
      voice,
      serverUrl,
      model,
      language,
      speed,
      controller.signal,
    );
    const label = await describeResult(result, model, serverUrl);
    return { ok: true, audio: result.audio, label, words: result.words };
  } catch (err) {
    // A deliberate stop aborts the fetch — report it as cancelled, not as an error.
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: (err as Error).message };
  } finally {
    fetches.delete(controller);
    if (fetches.size === 0) activeFetches.delete(tabId);
  }
}

/**
 * Pause/resume or skip the read in progress. Like Stop, it goes to every tab when the
 * worker has lost track of which tab is reading (it may have restarted since).
 */
async function controlPlayback(command: PlaybackCommand): Promise<void> {
  const tabIds = activeReads.size ? [...activeReads.keys()] : await getAllTabIds();
  for (const tabId of tabIds) notifyTab(tabId, { action: 'playback-control', command });
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
  speed: number,
  signal?: AbortSignal,
): Promise<TTSResult> {
  const url = `${serverUrl}/tts/generate`;
  const body: Record<string, string | number> = { text };
  if (voice) body.voice = voice;
  if (model) body.model = model;
  if (language) body.language = language;
  if (speed && speed !== 1) body.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));

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
    words: parseWordTimings(response.headers.get('X-Word-Timings')),
  };
}

/** `X-Word-Timings` as a list of [start, end, startSeconds, endSeconds]; [] if absent or bad. */
function parseWordTimings(header: string | null): number[][] {
  if (!header) return [];
  try {
    const words = JSON.parse(header) as unknown;
    if (!Array.isArray(words)) return [];
    return words.filter(
      (w): w is number[] =>
        Array.isArray(w) && w.length === 4 && w.every((n) => typeof n === 'number'),
    );
  } catch {
    return [];
  }
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
