# Tasks - Tasks

## In Progress

- [ ] Verify `linux-cpu` / `linux-cuda` extras on real Linux hosts (install + Kokoro generation incl. misaki/espeak); only dependency resolution has been checked so far

## To Do


## Backlog


## Done

- [x] Initialize uv project: pyproject.toml, .python-version, .gitignore
- [x] Server config: server/core/config.py (pydantic-settings, env vars)
- [x] TTS service singleton: server/core/tts_service.py (Eurydice client lifecycle)
- [x] API models: server/api/models.py (Pydantic request/response schemas)
- [x] Health endpoint: GET /health
- [x] Voices endpoint: GET /voices
- [x] TTS generate endpoint: POST /tts/generate (returns binary WAV)
- [x] App factory: server/main.py (FastAPI + CORS + lifespan + routes)
- [x] Server tests: tests/ (conftest, test_health, test_voices, test_tts)
- [x] Extension manifest + icons: extension/manifest.json
- [x] Background service worker: extension/background.js
- [x] Content script + UI overlay: extension/content.js
- [x] Extension popup: extension/popup/
- [x] Extension options page: extension/options/
- [x] README + docs/api.md
- [x] AGPL-3.0 license + SPDX headers across all source files
- [x] Fix background.js addEventListener bug + add chunk-highlight messaging
- [x] Implement page highlighting in content.js (CSS Highlight API + fallback)
- [x] JS tooling: package.json, eslint.config.js, .prettierrc.json
- [x] Pre-commit hooks: .pre-commit-config.yaml
- [x] Playwright extension tests: config, fixtures, helpers, test files
- [x] GitHub Actions: test.yml + release.yml
- [x] Generate a nicer icon (SVG + Playwright PNG generation script)
- [x] Restyle the extension — black and white flat design (popup, options, status bar)
- [x] Switch extension to TypeScript (src/ → extension/ compiled output)
- [x] Drop eurydice-tts backend; MLX (Kokoro) is the only TTS backend (deps, config, service, tests, docs). Voice/model validation now in MLXTTSService (ValueError → 400).
- [x] Platform extras `apple` / `linux-cpu` / `linux-cuda`. Each is marker-gated; cpu/cuda declared as a uv conflict (so `--all-extras` is unsupported); Linux torch (transitive via misaki[en] → spacy-curated-transformers, unused for inference) pinned to the PyTorch CPU index. Verified on macOS arm64: `uv sync --extra apple --extra dev`, Kokoro WAV for bm_george, ruff clean, 18 tests pass. Learned: the earlier "MLX is Apple-only" claim was wrong — mlx ships Linux cpu/cuda wheels.
- [x] Standalone setup: install eurydice-tts>=0.2.0 from PyPI instead of `../eurydice` path source (fresh clones failed `uv sync`); verified fresh-clone `uv sync --all-extras --locked` + Kokoro generation + pytest. Note: espeak-ng fails if the venv path is very long (~160+ chars) — not an issue for normal checkouts.
- [x] Prevent overlapping read-aloud and Test sound audio: track the active playback tab, stop prior playback across tabs, resolve pending audio on stop, and abort/release previous Test sound requests. Regenerate extension JavaScript and validate with the planned quality gates. Assumption: session ownership must prevent stale completion from clearing a newer playback session.

## Notes

- Reflection/verification: implemented cross-tab playback ownership, pending content-script audio resolution on stop, and Test sound fetch/audio cancellation and release; regenerated extension scripts. `pnpm typecheck`, `pnpm lint:js`, `uv run ruff check .`, `uv run ruff format --check --diff .`, and `uv run pytest` pass (18 tests). `pnpm format:js:check` flags five existing-style files including untouched `src/chunk-text.ts` and `src/popup/popup.ts`; formatting whole files would create unrelated churn. `pnpm test:ext` reached Playwright but 16 tests could not launch because configured Chromium is missing (6 passed). Follow-up: rerun extension tests after Chromium is installed; no functionality follow-up identified.
