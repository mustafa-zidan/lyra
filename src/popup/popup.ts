/**
 * Lyra TTS: Popup Script
 */

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusBadge = document.getElementById('status-badge') as HTMLElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;
const btnSelection = document.getElementById('btn-read-selection') as HTMLButtonElement;
const btnPage = document.getElementById('btn-read-page') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const optionsLink = document.getElementById('options-link') as HTMLAnchorElement;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Voice {
  id: string;
  name: string;
  default?: boolean;
}

interface Settings {
  serverUrl: string;
  defaultVoice: string;
  selectedModel: string;
}

interface BackgroundResponse {
  ok: boolean;
  available?: boolean;
  voices?: Voice[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const { serverUrl, defaultVoice, selectedModel } = await getSettings();

  // Check server health
  const health = await sendBackground({ action: 'health', serverUrl });
  updateStatusBadge(health.available ?? false);

  // Load voices for the selected model
  try {
    const { voices } = await sendBackground({ action: 'get-voices', serverUrl, model: selectedModel });
    populateVoices(voices ?? [], defaultVoice);
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
  btnSelection.addEventListener('click', () => readSelection(serverUrl, selectedModel));
  btnPage.addEventListener('click', () => readPage(serverUrl, selectedModel));
  btnStop.addEventListener('click', stopPlayback);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function readSelection(serverUrl: string, model: string): Promise<void> {
  const [tab] = await getTabs();
  if (!tab?.id) return;

  const response = await api.tabs.sendMessage(tab.id, { action: 'get-selection' }) as { text?: string } | undefined;
  const text = response?.text?.trim();
  if (!text) {
    statusBadge.textContent = 'No text selected';
    statusBadge.className = 'badge badge--error';
    return;
  }

  setPlaying(true);
  await sendBackground({ action: 'speak', text, voice: voiceSelect.value, serverUrl, model });
}

async function readPage(serverUrl: string, model: string): Promise<void> {
  const [tab] = await getTabs();
  if (!tab?.id) return;

    // Inject Readability.js into the page's content-script world
    await api.scripting.executeScript({
        target: {tabId: tab.id},
        files: ['/vendor/Readability.js'],
    });

    // Extract readable content with fallback chain
  const [result] = await api.scripting.executeScript({
    target: { tabId: tab.id },
      func: () => {
          const clone = document.cloneNode(true) as Document;
          try {
              // @ts-expect-error Readability injected as global by prior executeScript
              const article = new Readability(clone).parse();
              if (article?.textContent?.trim()) {
                  return article.textContent.trim();
              }
          } catch {
              /* fall through to fallback */
          }

          // Fallback: semantic HTML elements
          for (const sel of ['article', 'main', '[role="main"]']) {
              const el = document.querySelector(sel);
              if (el?.textContent?.trim() && el.textContent.trim().length > 100) {
                  return el.textContent.trim();
              }
          }
          // Last resort: full page text
          return document.body.innerText;
      },
  });

  const text = (result?.result as string | undefined)?.trim();
  if (!text) return;

  setPlaying(true);
  await sendBackground({ action: 'speak', text, voice: voiceSelect.value, serverUrl, model });
}

async function stopPlayback(): Promise<void> {
  setPlaying(false);
  await sendBackground({ action: 'stop' });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateStatusBadge(available: boolean): void {
  if (available) {
    statusBadge.textContent = 'Online';
    statusBadge.className = 'badge badge--ok';
  } else {
    statusBadge.textContent = 'Server offline';
    statusBadge.className = 'badge badge--error';
  }
}

function populateVoices(voices: Voice[], defaultVoice: string): void {
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

function setPlaying(playing: boolean): void {
  btnSelection.style.display = playing ? 'none' : '';
  btnPage.style.display = playing ? 'none' : '';
  btnStop.style.display = playing ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    api.storage.local.get(
      { serverUrl: 'http://127.0.0.1:8000', defaultVoice: 'af_heart', selectedModel: 'mlx-community/Kokoro-82M-bf16' },
      (items) => {
        resolve(items as unknown as Settings);
      },
    );
  });
}

function sendBackground(message: Record<string, unknown>): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    api.runtime.sendMessage(message, (response) => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
      } else {
        resolve((response as BackgroundResponse) ?? {});
      }
    });
  });
}

function getTabs(): Promise<chrome.tabs.Tab[]> {
  return new Promise((resolve) => {
    api.tabs.query({ active: true, currentWindow: true }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

export {};
