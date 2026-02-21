// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Playwright global setup — starts the WAV stub server used by extension tests.
 * Picks a random available port and writes it to a temp file so tests can read it.
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

const VOICES_RESPONSE = JSON.stringify({
  voices: [
    { id: 'leo', name: 'Leo', default: true },
    { id: 'tara', name: 'Tara', default: false },
  ],
});

let server;

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

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tts_available: true, provider: 'mock' }));
      return;
    }

    if (req.url === '/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(VOICES_RESPONSE);
      return;
    }

    if (req.url === '/tts/generate' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'X-Audio-Duration': '0.001',
        'X-Cached': 'false',
        'X-Voice': 'leo',
      });
      res.end(WAV_STUB);
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
