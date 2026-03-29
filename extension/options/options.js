/**
 * Lyra TTS: Options Page Script
 */
const api = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';
const DEFAULT_VOICE = 'af_heart';
const DEFAULT_MODEL = 'mlx-community/Kokoro-82M-bf16';
// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const serverUrlInput = document.getElementById('server-url');
const modelSelect = document.getElementById('model-select');
const defaultVoiceSelect = document.getElementById('default-voice');
const btnCheck = document.getElementById('btn-check');
const btnSave = document.getElementById('btn-save');
const btnReset = document.getElementById('btn-reset');
const btnTestSound = document.getElementById('btn-test-sound');
const serverStatus = document.getElementById('server-status');
const saveMsg = document.getElementById('save-msg');
const testStatus = document.getElementById('test-status');
// ---------------------------------------------------------------------------
// Load saved settings
// ---------------------------------------------------------------------------
async function loadSettings() {
    const { serverUrl, defaultVoice, selectedModel } = await getSettings();
    serverUrlInput.value = serverUrl;
    // Try to populate models and voices from the server
    try {
        const modelsResp = await api.runtime.sendMessage({ action: 'get-models', serverUrl });
        if (modelsResp?.models?.length) {
            populateModels(modelsResp.models, selectedModel);
        }
        else {
            populateModels([], selectedModel);
        }
    }
    catch {
        populateModels([], selectedModel);
    }
    await refreshVoices(serverUrl, modelSelect.value || selectedModel, defaultVoice);
}
// ---------------------------------------------------------------------------
// Check server connectivity
// ---------------------------------------------------------------------------
async function checkServer() {
    const url = serverUrlInput.value.trim();
    if (!url) {
        setStatus('Enter a server URL first.', 'error');
        return;
    }
    setStatus('Checking…', 'idle');
    try {
        const healthResp = await api.runtime.sendMessage({ action: 'health', serverUrl: url });
        if (!healthResp?.available) {
            setStatus('Server reachable but TTS backend offline.', 'error');
            return;
        }
        setStatus(`Connected ✓  (provider: ${healthResp.status ?? 'ok'})`, 'ok');
        // Refresh models
        const modelsResp = await api.runtime.sendMessage({ action: 'get-models', serverUrl: url });
        if (modelsResp?.models?.length) {
            populateModels(modelsResp.models, modelSelect.value);
        }
        // Refresh voices for current model
        await refreshVoices(url, modelSelect.value, defaultVoiceSelect.value);
    }
    catch (err) {
        setStatus(`Cannot reach server: ${err.message}`, 'error');
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function refreshVoices(serverUrl, modelId, selectedVoiceId) {
    try {
        const resp = await api.runtime.sendMessage({
            action: 'get-voices',
            serverUrl,
            model: modelId,
        });
        if (resp?.voices?.length) {
            populateVoices(resp.voices, selectedVoiceId);
        }
        else {
            populateVoices([], selectedVoiceId);
        }
    }
    catch {
        populateVoices([], selectedVoiceId);
    }
}
function populateModels(modelList, selectedId) {
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
function populateVoices(voices, selectedId) {
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
function setStatus(message, type) {
    serverStatus.textContent = message;
    serverStatus.className = `server-status server-status--${type}`;
}
async function getSettings() {
    return new Promise((resolve) => {
        api.storage.local.get({ serverUrl: DEFAULT_SERVER_URL, defaultVoice: DEFAULT_VOICE, selectedModel: DEFAULT_MODEL }, (items) => {
            resolve(items);
        });
    });
}

// ---------------------------------------------------------------------------
// Test Sound
// ---------------------------------------------------------------------------
async function testSound() {
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
        const body = {
            text: testText,
            voice: voice || DEFAULT_VOICE
        };
        if (model)
            body.model = model;
        const response = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const json = await response.json().catch(() => ({}));
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
        testStatus.textContent = `Error: ${err.message}`;
        testStatus.className = 'test-status test-status--error';
        setTimeout(() => {
            testStatus.style.display = 'none';
        }, 5000);
    }
}
// ---------------------------------------------------------------------------
// Save / Reset
// ---------------------------------------------------------------------------
async function saveSettings() {
    const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
    const defaultVoice = defaultVoiceSelect.value || DEFAULT_VOICE;
    const selectedModel = modelSelect.value || DEFAULT_MODEL;
    await new Promise((resolve) => {
        api.storage.local.set({ serverUrl, defaultVoice, selectedModel }, resolve);
    });
    saveMsg.textContent = 'Settings saved!';
    setTimeout(() => {
        saveMsg.textContent = '';
    }, 2500);
}
function resetSettings() {
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
