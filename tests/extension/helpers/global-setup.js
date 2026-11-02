// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Playwright global setup, starts the WAV stub server used by extension tests.
 * Picks a random available port and writes it to a temp file, so tests can read it.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

export const PORT_FILE = path.join(os.tmpdir(), 'lyra-test-server-port');

/** Minimal valid WAV: 44-byte header + 2 bytes of silence at 16 kHz. */
const WAV_STUB = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74,
  0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d,
  0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00,
  0x00,
]);

/** A silent 16 kHz mono WAV of the given length. */
function silentWav(seconds) {
  const samples = Math.round(16000 * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

const MODEL_ID = 'mlx-community/Kokoro-82M-bf16';

const VOICES_RESPONSE = JSON.stringify({
  model: MODEL_ID,
  voices: [
    { id: 'af_heart', name: 'Heart', language: 'English (US)', gender: 'Female', default: true },
    { id: 'bm_george', name: 'George', language: 'English (UK)', gender: 'Male', default: false },
  ],
});

const MODELS_RESPONSE = JSON.stringify({
  models: [
    {
      id: MODEL_ID,
      name: 'Kokoro 82M',
      description: 'Mock model',
      languages: ['en-US', 'en-GB'],
      default: true,
    },
  ],
});

let server;
/** Texts sent to /tts/generate, in arrival order; read and reset via /__tts-log. */
const ttsLog = [];
/** Full /tts/generate request bodies; read and reset via /__tts-requests. */
const ttsRequests = [];

export default async function globalSetup() {
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // The extension adds query strings (e.g. /voices?model=…), so route on the path.
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tts_available: true, provider: 'mock' }));
      return;
    }

    if (pathname === '/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(VOICES_RESPONSE);
      return;
    }

    if (pathname === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(MODELS_RESPONSE);
      return;
    }

    if (pathname === '/__tts-log') {
      if (req.method === 'DELETE') ttsLog.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ttsLog));
      return;
    }

    if (pathname === '/__tts-requests') {
      if (req.method === 'DELETE') ttsRequests.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ttsRequests));
      return;
    }

    if (pathname === '/tts/generate' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // logged as null
        }
        ttsLog.push(json?.text ?? null);
        ttsRequests.push(json);
        // Text carrying a "[2s]" marker gets that much (silent) audio, for playback tests;
        // anything else gets the tiny stub, so reads finish at once.
        const seconds = Number(/\[(\d+(?:\.\d+)?)s\]/.exec(json?.text ?? '')?.[1] ?? 0);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'X-Audio-Duration': String(seconds || 0.001),
          'X-Cached': 'false',
          'X-Voice': 'af_heart',
          'X-Model': MODEL_ID,
          'X-Language': 'English (US)',
        });
        res.end(seconds ? silentWav(seconds) : WAV_STUB);
      });
      return;
    }

    // Serve static fixture files for content-script integration tests
    if (req.url.startsWith('/fixtures/') && req.method === 'GET') {
      const filePath = path.join(FIXTURES_DIR, req.url.slice('/fixtures/'.length));
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  // Port 0 → OS assigns a free port
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // Persist port so extension options/popup can read the mock server URL
  fs.writeFileSync(PORT_FILE, String(port));
  console.log(`[global-setup] Mock TTS server on http://127.0.0.1:${port}`);

  return async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(PORT_FILE, { force: true });
    console.log('[global-setup] Mock TTS server stopped');
  };
}
