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
        const tabId = sender.tab?.id ?? (await getActiveTabId());
        if (tabId)
            notifyTab(tabId, { action: 'playback-stopped' });
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
    notifyTab(tabId, { action: 'playback-started', text });
    try {
        const chunks = chunkText(text);
        for (const chunk of chunks) {
            // Signal content script to highlight this chunk before fetching audio
            notifyTab(tabId, { action: 'chunk-highlight', text: chunk });
            const audioBase64 = await fetchTTS(chunk, voice, serverUrl, model);
            await api.scripting.executeScript({
                target: { tabId },
                func: playAudioInPage,
                args: [audioBase64],
            });
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
 * Fetch audio from the TTS server and return it as a base64 data URL.
 */
async function fetchTTS(text, voice, serverUrl, model) {
    const url = `${serverUrl}/tts/generate`;
    const body = { text, voice: voice || DEFAULT_VOICE };
    if (model)
        body.model = model;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    return `data:audio/wav;base64,${btoa(binary)}`;
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
 * Plays a base64-encoded WAV in the page.
 * Serialised and injected via scripting.executeScript — must be self-contained.
 */
function playAudioInPage(audioDataUrl) {
    return new Promise((resolve, reject) => {
        const audio = new Audio(audioDataUrl);
        audio.onended = () => resolve();
        audio.onerror = (e) => reject(new Error(`Audio playback error: ${e.message}`));
        audio.play().catch(reject);
    });
}
export {};
