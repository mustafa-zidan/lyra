# Tasks - Tasks

## In Progress

- [ ] AGPL-3.0 license + SPDX headers across all source files
- [ ] Fix background.js addEventListener bug + add chunk-highlight messaging
- [ ] Implement page highlighting in content.js (CSS Highlight API + fallback)
- [ ] JS tooling: package.json, eslint.config.js, .prettierrc.json
- [ ] Pre-commit hooks: .pre-commit-config.yaml
- [ ] Playwright extension tests: config, fixtures, helpers, test files
- [ ] GitHub Actions: test.yml + release.yml

## To Do


## Backlog
- [ ] switch to extensions typescript if possible
- [ ] restyle the extension 
- [ ] generate a nicer icon

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
