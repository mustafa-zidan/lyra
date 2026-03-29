/**
 * Lyra TTS: Options Page Script
 */

const api: typeof chrome = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_MODEL = 'mlx-community/Kokoro-82M-bf16';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const serverUrlInput = document.getElementById('server-url') as HTMLInputElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const defaultVoiceSelect = document.getElementById('default-voice') as HTMLSelectElement;
const btnCheck = document.getElementById('btn-check') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
const btnTestSound = document.getElementById('btn-test-sound') as HTMLButtonElement;
const serverStatus = document.getElementById('server-status') as HTMLElement;
const saveMsg = document.getElementById('save-msg') as HTMLElement;
const testStatus = document.getElementById('test-status') as HTMLElement;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface Settings {
  serverUrl: string;
  defaultVoice: string;
  selectedModel: string;
}

// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------

async function loadSettings(): Promise<void> {
  const { serverUrl, defaultVoice, selectedModel } = await getSettings();
  serverUrlInput.value = serverUrl;

  // Try to populate models and voices from the server
  try {
    const modelsResp = await api.runtime.sendMessage({ action: 'get-models', serverUrl }) as
      | { models?: ModelInfo[] }
      | undefined;
    if (modelsResp?.models?.length) {
      populateModels(modelsResp.models, selectedModel);
    } else {
      populateModels([], selectedModel);
    }
  } catch {
    populateModels([], selectedModel);
  }

  await refreshVoices(serverUrl, modelSelect.value || selectedModel, defaultVoice);
}

// ---------------------------------------------------------------------------
// Check server connectivity
// ---------------------------------------------------------------------------

async function checkServer(): Promise<void> {
  const url = serverUrlInput.value.trim();
  if (!url) {
    setStatus('Enter a server URL first.', 'error');
    return;
  }

  setStatus('Checking…', 'idle');
  try {
    const healthResp = await api.runtime.sendMessage({ action: 'health', serverUrl: url }) as
      | { available?: boolean; status?: string }
      | undefined;

    if (!healthResp?.available) {
      setStatus('Server reachable but TTS backend offline.', 'error');
      return;
    }

    setStatus(`Connected ✓  (provider: ${healthResp.status ?? 'ok'})`, 'ok');

    // Refresh models
    const modelsResp = await api.runtime.sendMessage({ action: 'get-models', serverUrl: url }) as
      | { models?: ModelInfo[] }
      | undefined;
    if (modelsResp?.models?.length) {
      populateModels(modelsResp.models, modelSelect.value);
    }

    // Refresh voices for current model
    await refreshVoices(url, modelSelect.value, defaultVoiceSelect.value);
  } catch (err) {
    setStatus(`Cannot reach server: ${(err as Error).message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function refreshVoices(serverUrl: string, modelId: string, selectedVoiceId: string): Promise<void> {
  try {
    const resp = await api.runtime.sendMessage({
      action: 'get-voices',
      serverUrl,
      model: modelId,
    }) as { voices?: Voice[] } | undefined;

    if (resp?.voices?.length) {
      populateVoices(resp.voices, selectedVoiceId);
    } else {
      populateVoices([], selectedVoiceId);
    }
  } catch {
    populateVoices([], selectedVoiceId);
  }
}

function populateModels(modelList: ModelInfo[], selectedId: string): void {
  const current = modelSelect.value;
  modelSelect.innerHTML = '';

  if (modelList.length === 0) {
    // Fallback: add only the default model as a placeholder
    const opt = document.createElement('option');
    opt.value = DEFAULT_MODEL;
    opt.textContent = 'Kokoro 82M (default)';
    modelSelect.appendChild(opt);
    modelSelect.value = selectedId || DEFAULT_MODEL;
    return;
  }

  for (const m of modelList) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name} — ${m.languages.join(', ')}`;
    opt.title = m.description;
    modelSelect.appendChild(opt);
  }
  modelSelect.value = selectedId || current || DEFAULT_MODEL;
}

function populateVoices(voices: Voice[], selectedId: string): void {
  const current = defaultVoiceSelect.value;
  defaultVoiceSelect.innerHTML = '';

  if (voices.length === 0) {
    const opt = document.createElement('option');
    opt.value = DEFAULT_VOICE;
    opt.textContent = 'Default';
    defaultVoiceSelect.appendChild(opt);
    defaultVoiceSelect.value = selectedId || DEFAULT_VOICE;
    return;
  }

  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.name;
    defaultVoiceSelect.appendChild(opt);
  }
  defaultVoiceSelect.value = selectedId || current || DEFAULT_VOICE;
}

function setStatus(message: string, type: 'idle' | 'ok' | 'error'): void {
  serverStatus.textContent = message;
  serverStatus.className = `server-status server-status--${type}`;
}

async function getSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    api.storage.local.get(
      { serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE, selectedModel: DEFAULT_MODEL },
      (items) => {
        resolve(items as unknown as Settings);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Test Sound
// ---------------------------------------------------------------------------

async function testSound(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  const voice = defaultVoiceSelect.value || DEFAULT_VOICE;
  const model = modelSelect.value || DEFAULT_MODEL;

  // Test message
  const testText = "Hello! This is a test of the text-to-speech system.";

  // Show status
  testStatus.style.display = 'block';
  testStatus.textContent = 'Playing test sound...';
  testStatus.className = 'test-status test-status--playing';

  try {
    // Fetch TTS audio directly from the server
    const url = `${serverUrl}/tts/generate`;
    const body: Record<string, string> = {
      text: testText,
      voice: voice || DEFAULT_VOICE
    };
    if (model) body.model = model;

    const response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const json = await response.json().catch(() => ({})) as { detail?: string };
      throw new Error(json.detail ?? `Server error ${response.status}`);
    }

    // Get the audio data as blob
    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    // Play the audio using HTML5 Audio
    const audio = new Audio(audioUrl);

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      testStatus.textContent = 'Test sound played successfully!';
      testStatus.className = 'test-status test-status--success';
      setTimeout(() => {
        testStatus.style.display = 'none';
      }, 3000);
    };

    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      throw new Error('Failed to play audio');
    };

    await audio.play();

  } catch (err) {
    testStatus.textContent = `Error: ${(err as Error).message}`;
    testStatus.className = 'test-status test-status--error';
    setTimeout(() => {
      testStatus.style.display = 'none';
    }, 5000);
  }
}

// ---------------------------------------------------------------------------
// Save / Reset
// ---------------------------------------------------------------------------

async function saveSettings(): Promise<void> {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  const defaultVoice = defaultVoiceSelect.value || DEFAULT_VOICE;
  const selectedModel = modelSelect.value || DEFAULT_MODEL;

  await new Promise<void>((resolve) => {
    api.storage.local.set({ serverUrl, defaultVoice, selectedModel }, resolve);
  });

  saveMsg.textContent = 'Settings saved!';
  setTimeout(() => {
    saveMsg.textContent = '';
  }, 2500);
}

function resetSettings(): void {
  serverUrlInput.value = DEFAULT_SERVER_URL;
  populateModels([], DEFAULT_MODEL);
  populateVoices([], DEFAULT_VOICE);
  setStatus('Reset to defaults. Click Save to apply.', 'idle');
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

btnCheck.addEventListener('click', checkServer);
btnSave.addEventListener('click', saveSettings);
btnReset.addEventListener('click', resetSettings);
btnTestSound.addEventListener('click', testSound);

// When model changes, refresh voice list
modelSelect.addEventListener('change', async () => {
  const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
  await refreshVoices(serverUrl, modelSelect.value, '');
});

document.addEventListener('DOMContentLoaded', loadSettings);

export {};
