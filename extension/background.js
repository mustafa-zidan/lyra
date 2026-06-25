// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lyra TTS - Background Service Worker
 *
 * Responsibilities:
 *  - Register the context-menu item
 *  - Fetch audio from the Eurydice/MLX server
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
// ---------------------------------------------------------------------------
// Playback cancellation state
// ---------------------------------------------------------------------------
/**
 * Monotonic id for the active read. Each call to speakInTab claims the next id;
 * a running loop bails the moment `playbackSession` moves past its own id, so
 * pressing Stop (which bumps the id) or starting a new read cancels the old one.
 */
let playbackSession = 0;
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
        await speakInTab(tab.id, text, defaultVoice, serverUrl, selectedModel);
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
        const { text, voice, serverUrl, model } = message;
        const tabId = sender.tab?.id ?? (await getActiveTabId());
        if (!tabId)
            return { ok: false, error: 'No active tab' };
        speakInTab(tabId, text, voice, serverUrl, model ?? DEFAULT_MODEL).catch(console.error);
        return { ok: true };
    }
    if (action === 'stop') {
        // Invalidate any running read loop and abort an in-flight fetch.
        playbackSession++;
        activeFetch?.abort();
        activeFetch = null;
        const tabId = sender.tab?.id ?? (await getActiveTabId());
        if (tabId) {
            await stopAudioInTab(tabId); // halt audio already playing in the page
            notifyTab(tabId, { action: 'playback-stopped' });
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
async function speakInTab(tabId, text, voice, serverUrl, model) {
    // Claim this read; any older loop will see playbackSession move past its id.
    const session = ++playbackSession;
    activeFetch?.abort();
    activeFetch = null;
    await stopAudioInTab(tabId); // stop audio lingering from a previous read
    notifyTab(tabId, { action: 'playback-started', text });
    try {
        const chunks = chunkText(text);
        for (const chunk of chunks) {
            if (session !== playbackSession)
                return; // stopped or superseded
            // Signal content script to highlight this chunk before fetching audio
            notifyTab(tabId, { action: 'chunk-highlight', text: chunk });
            const controller = new AbortController();
            activeFetch = controller;
            let audioBase64;
            try {
                audioBase64 = await fetchTTS(chunk, voice, serverUrl, model, controller.signal);
            }
            catch (err) {
                // A deliberate stop aborts the fetch — swallow it, don't show an error.
                if (controller.signal.aborted || session !== playbackSession)
                    return;
                throw err;
            }
            finally {
                if (activeFetch === controller)
                    activeFetch = null;
            }
            if (session !== playbackSession)
                return; // stopped while fetching
            await api.scripting.executeScript({
                target: { tabId },
                func: playAudioInPage,
                args: [audioBase64],
            });
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
}
/**
 * Fetch audio from the TTS server and return raw WAV bytes as a base64 string.
 * We intentionally do NOT produce a data: URL — pages with strict CSP (e.g. GitHub)
 * block data: URIs in media-src. The base64 payload is decoded in-page via the Web
 * Audio API (decodeAudioData) which operates on an ArrayBuffer and is not subject to
 * media-src CSP restrictions.
 */
async function fetchTTS(text, voice, serverUrl, model, signal) {
    const url = `${serverUrl}/tts/generate`;
    const body = { text, voice: voice || DEFAULT_VOICE };
    if (model)
        body.model = model;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(json.detail ?? `Server error ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (const b of bytes)
        binary += String.fromCharCode(b);
    return btoa(binary); // raw base64, no data: prefix
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
    const data = await response.json();
    return data.voices ?? [];
}
/**
 * Fetch the list of available models from the server.
 */
async function fetchModels(serverUrl) {
    const response = await fetch(`${serverUrl}/models`);
    if (!response.ok)
        throw new Error(`Models request failed: ${response.status}`);
    const data = await response.json();
    return data.models ?? [];
}
/**
 * Fetch server health status.
 */
async function fetchHealth(serverUrl) {
    try {
        const response = await fetch(`${serverUrl}/health`);
        const data = await response.json();
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
// Injected function — runs inside the page context
// ---------------------------------------------------------------------------
/**
 * Decodes a raw base64 WAV string and plays it via the Web Audio API.
 *
 * Injected into the page via scripting.executeScript — must be self-contained.
 *
 * Using Web Audio API (decodeAudioData on an ArrayBuffer) instead of
 * `new Audio(dataUrl)` deliberately sidesteps the page's media-src CSP: the
 * directive only governs URL-based media resources, not in-memory ArrayBuffers.
 */
async function playAudioInPage(base64Wav) {
    const w = window;
    // Decode base64 → ArrayBuffer without constructing any URL
    const binary = atob(base64Wav);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        buf[i] = binary.charCodeAt(i);
    const ctx = new AudioContext();
    // Publish a stop handle so stopAudioInPage() can halt this immediately.
    const state = { ctx, source: null, stopped: false };
    w.__lyraAudio = state;
    if (ctx.state === 'suspended')
        await ctx.resume();
    const decoded = await ctx.decodeAudioData(buf.buffer);
    // Stop may have been requested while we were resuming/decoding.
    if (state.stopped) {
        ctx.close();
        return;
    }
    const source = ctx.createBufferSource();
    state.source = source;
    source.buffer = decoded;
    source.connect(ctx.destination);
    await new Promise((resolve) => {
        source.onended = () => {
            if (ctx.state !== 'closed')
                ctx.close();
            if (w.__lyraAudio === state)
                w.__lyraAudio = undefined;
            resolve();
        };
        source.start(0);
    });
}
/**
 * Stops any audio started by playAudioInPage immediately. Injected into the page
 * (same isolated world as playAudioInPage, so it sees the shared window handle).
 */
function stopAudioInPage() {
    const w = window;
    const state = w.__lyraAudio;
    if (!state)
        return;
    state.stopped = true;
    try {
        state.source?.stop();
    }
    catch {
        // source may not have started yet — ignore
    }
    try {
        if (state.ctx.state !== 'closed')
            state.ctx.close();
    }
    catch {
        // context already closed — ignore
    }
    w.__lyraAudio = undefined;
}
/** Inject stopAudioInPage into a tab to halt any audio currently playing there. */
async function stopAudioInTab(tabId) {
    try {
        await api.scripting.executeScript({ target: { tabId }, func: stopAudioInPage });
    }
    catch {
        // Tab may not permit injection (e.g. chrome:// pages) — safe to ignore
    }
}
export {};
