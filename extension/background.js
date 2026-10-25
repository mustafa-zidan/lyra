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
const api = typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : null;
// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_MODEL = 'mlx-community/Kokoro-82M-bf16';
const CONTEXT_MENU_ID = 'lyra-read-selection';
/** A chunk taking longer than this is probably loading (or downloading) a model. */
const SLOW_REQUEST_MS = 8000;
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
let playbackTabId = null;
/** AbortController for the in-flight chunk fetch, so Stop can cancel mid-request. */
let activeFetch = null;
// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
async function getSettings() {
    return new Promise((resolve) => {
        api.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE, selectedModel: DEFAULT_MODEL }, (items) => {
            resolve(items);
        });
    });
}
// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
if (api) {
    api.runtime.onInstalled.addListener(() => {
        api.contextMenus.create({
            id: CONTEXT_MENU_ID,
            title: 'Read selection aloud with Lyra',
            contexts: ['selection'],
        });
    });
    api.contextMenus.onClicked.addListener(async (info, tab) => {
        if (info.menuItemId !== CONTEXT_MENU_ID)
            return;
        const text = info.selectionText?.trim();
        if (!text || !tab?.id)
            return;
        const { serverUrl, defaultVoice, selectedModel } = await getSettings();
        const selection = (await api.tabs
            .sendMessage(tab.id, { action: 'get-selection' })
            .catch(() => undefined));
        await speakInTab(tab.id, text, defaultVoice, serverUrl, selectedModel, selection?.language);
    });
    // ---------------------------------------------------------------------------
    // Message handling (from popup / content script)
    // ---------------------------------------------------------------------------
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleMessage(message, sender)
            .then(sendResponse)
            .catch((err) => {
            sendResponse({ ok: false, error: err.message });
        });
        return true; // keep channel open for async response
    });
}
async function handleMessage(message, sender) {
    const { action } = message;
    if (action === 'speak') {
        const tabId = sender.tab?.id ?? (await getActiveTabId());
        if (!tabId)
            return { ok: false, error: 'No active tab' };
        const text = message.text?.trim();
        if (!text)
            return { ok: false, error: 'No text provided' };
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
        // Invalidate any running read loop and abort an in-flight fetch.
        playbackSession++;
        const readingTabId = playbackTabId;
        playbackTabId = null;
        activeFetch?.abort();
        activeFetch = null;
        const tabId = sender.tab?.id ?? (await getActiveTabId());
        const tabsToStop = new Set();
        if (readingTabId !== null)
            tabsToStop.add(readingTabId);
        if (tabId !== null)
            tabsToStop.add(tabId);
        for (const targetTabId of tabsToStop) {
            await stopAudioInTab(targetTabId); // halt audio already playing in the page
            notifyTab(targetTabId, { action: 'playback-stopped' });
        }
        return { ok: true };
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
 * Generate speech for each chunk of text, highlighting and playing sequentially.
 */
async function speakInTab(tabId, text, voice, serverUrl, model, language) {
    // Claim this read; any older loop will see playbackSession move past its id.
    const session = ++playbackSession;
    const previousTabId = playbackTabId;
    playbackTabId = tabId;
    activeFetch?.abort();
    activeFetch = null;
    if (previousTabId !== null && previousTabId !== tabId) {
        await stopAudioInTab(previousTabId);
        notifyTab(previousTabId, { action: 'playback-stopped' });
    }
    await stopAudioInTab(tabId); // stop audio lingering from a previous read
    if (session !== playbackSession)
        return;
    notifyTab(tabId, { action: 'playback-started', text });
    try {
        const chunks = chunkText(text);
        let statusLabel = '';
        for (const chunk of chunks) {
            if (session !== playbackSession)
                return; // stopped or superseded
            // Signal content script to highlight this chunk before fetching audio
            notifyTab(tabId, { action: 'chunk-highlight', text: chunk });
            const controller = new AbortController();
            activeFetch = controller;
            // The server gives no progress while it loads a model, and switching to one not
            // used before downloads it (and converts it, for German), so say so when a chunk is slow.
            const slowTimer = setTimeout(() => {
                notifyTab(tabId, {
                    action: 'playback-status',
                    text: 'Loading model… the first use downloads it, which can take a while',
                });
                statusLabel = '';
            }, SLOW_REQUEST_MS);
            let result;
            try {
                result = await fetchTTS(chunk, voice, serverUrl, model, language, controller.signal);
            }
            catch (err) {
                // A deliberate stop aborts the fetch — swallow it, don't show an error.
                if (controller.signal.aborted || session !== playbackSession)
                    return;
                throw err;
            }
            finally {
                clearTimeout(slowTimer);
                if (activeFetch === controller)
                    activeFetch = null;
            }
            if (session !== playbackSession)
                return; // stopped while fetching
            const label = await describeResult(result, model, serverUrl);
            if (label !== statusLabel) {
                statusLabel = label;
                notifyTab(tabId, { action: 'playback-status', text: label });
            }
            await playAudioInTab(tabId, result.audio);
            if (session !== playbackSession)
                return; // stopped during playback
        }
        // Clear highlight after all chunks finish
        notifyTab(tabId, { action: 'chunk-highlight', text: null });
        notifyTab(tabId, { action: 'playback-finished' });
    }
    catch (err) {
        notifyTab(tabId, { action: 'chunk-highlight', text: null });
        notifyTab(tabId, { action: 'playback-error', error: err.message });
    }
    finally {
        if (session === playbackSession && playbackTabId === tabId)
            playbackTabId = null;
    }
}
/** Model display names per server URL, for naming a model the server switched to. */
const modelNames = new Map();
/**
 * Status-bar label for a generated chunk: the language, plus the model when the server
 * switched away from the requested one (e.g. "Reading aloud · German · Kokoro 82M German (Victoria)").
 */
async function describeResult(result, requestedModel, serverUrl) {
    const parts = ['Reading aloud'];
    if (result.language)
        parts.push(result.language);
    if (result.model && result.model !== requestedModel) {
        let names = modelNames.get(serverUrl);
        if (!names) {
            const models = await fetchModels(serverUrl).catch(() => []);
            names = new Map(models.map((m) => [m.id, m.name]));
            if (names.size)
                modelNames.set(serverUrl, names);
        }
        parts.push(names.get(result.model) ?? result.model.split('/').pop());
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
async function fetchTTS(text, voice, serverUrl, model, language, signal) {
    const url = `${serverUrl}/tts/generate`;
    const body = { text };
    if (voice)
        body.voice = voice;
    if (model)
        body.model = model;
    if (language)
        body.language = language;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const json = (await response.json().catch(() => ({})));
        throw new Error(json.detail ?? `Server error ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return {
        audio: btoa(binary), // raw base64, no data: prefix
        model: response.headers.get('X-Model'),
        language: response.headers.get('X-Language'),
    };
}
/**
 * Fetch the list of available voices from the server for a given model.
 */
async function fetchVoices(serverUrl, model) {
    const url = new URL(`${serverUrl}/voices`);
    if (model)
        url.searchParams.set('model', model);
    const response = await fetch(url.toString());
    if (!response.ok)
        throw new Error(`Voices request failed: ${response.status}`);
    const data = (await response.json());
    return data.voices ?? [];
}
/**
 * Fetch the list of available models from the server.
 */
async function fetchModels(serverUrl) {
    const response = await fetch(`${serverUrl}/models`);
    if (!response.ok)
        throw new Error(`Models request failed: ${response.status}`);
    const data = (await response.json());
    return data.models ?? [];
}
/**
 * Fetch server health status.
 */
async function fetchHealth(serverUrl) {
    try {
        const response = await fetch(`${serverUrl}/health`);
        const data = (await response.json());
        return { available: data.tts_available, status: data.status };
    }
    catch {
        return { available: false, status: 'unreachable' };
    }
}
// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------
/**
 * Split text at sentence boundaries into chunks of at most `maxLen` characters.
 * Recognises Latin, CJK (。！？) and Devanagari (।) sentence marks.
 */
function chunkText(text, maxLen = 500) {
    const sentences = text.match(/[^.!?。！？｡।]+[.!?。！？｡।]*/g) ?? [text];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        if (current.length + sentence.length > maxLen && current.length > 0) {
            chunks.push(current.trim());
            current = '';
        }
        current += sentence;
    }
    if (current.trim())
        chunks.push(current.trim());
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
async function playAudioInTab(tabId, audioBase64) {
    try {
        await api.tabs.sendMessage(tabId, { action: 'play-audio', audio: audioBase64 });
    }
    catch {
        // Tab closed or no content script present — safe to ignore.
    }
}
/** Tell the content script to halt any audio currently playing in the tab. */
async function stopAudioInTab(tabId) {
    notifyTab(tabId, { action: 'stop-audio' });
}
export {};
