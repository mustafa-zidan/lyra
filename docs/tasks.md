# Tasks - Tasks

## In Progress

- [ ] Verify `linux-cpu` / `linux-cuda` extras on real Linux hosts (install + Kokoro generation incl. misaki/espeak);
  only dependency resolution has been checked so far

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
- [x] Drop eurydice-tts backend; MLX (Kokoro) is the only TTS backend (deps, config, service, tests, docs). Voice/model
  validation now in MLXTTSService (ValueError → 400).
- [x] Platform extras `apple` / `linux-cpu` / `linux-cuda`. Each is marker-gated; cpu/cuda declared as a uv conflict (so
  `--all-extras` is unsupported); Linux torch (transitive via misaki[en] → spacy-curated-transformers, unused for
  inference) pinned to the PyTorch CPU index. Verified on macOS arm64: `uv sync --extra apple --extra dev`, Kokoro WAV
  for bm_george, ruff clean, 18 tests pass. Learned: the earlier "MLX is Apple-only" claim was wrong — mlx ships Linux
  cpu/cuda wheels.
- [x] Standalone setup: install eurydice-tts>=0.2.0 from PyPI instead of `../eurydice` path source (fresh clones failed
  `uv sync`); verified fresh-clone `uv sync --all-extras --locked` + Kokoro generation + pytest. Note: espeak-ng fails
  if the venv path is very long (~160+ chars) — not an issue for normal checkouts.
- [x] Prevent overlapping read-aloud and Test sound audio: track the active playback tab, stop prior playback across
  tabs, resolve pending audio on stop, and abort/release previous Test sound requests. Regenerate extension JavaScript
  and validate with the planned quality gates. Assumption: session ownership must prevent stale completion from clearing
  a newer playback session.

- [x] Support every Kokoro language (en-US/en-GB, ja, zh, es, fr, hi, it, pt). Root cause of Japanese gibberish: the
  extension always sends the user's (English) voice, so kana went through misaki's English G2P. Implemented: platform
  extras install `misaki[en,ja,zh]` + `unidic-lite` (misaki[ja] depends on `unidic`, which ships without its ~500 MB
  dictionary; the service points `unidic.DICDIR` at unidic-lite unless the full one was downloaded). Server resolves the
  language per request (Japanese/Chinese/Hindi script in the text → optional BCP-47 `language` hint → voice prefix;
  kanji-only text + `ja` hint stays Japanese) and swaps in a matching voice (`X-Voice`, new `X-Language` header).
  Non-English text also splits on 。！？｡। to avoid the pipeline's 510-phoneme truncation. Extension sends the nearest
  `lang` attribute (selection button, context menu, popup selection/page) and chunks on CJK/Devanagari sentence marks.
  Patched an mlx-audio (<= 0.6.1, still unfixed upstream) float-rounding crash in Kokoro's SineGen
  (`ceil(34200 * (1/300)) == 115` → broadcast error); it is length-dependent, so it could hit any language. Verified:
  real synthesis for all 9 languages from an `af_heart` request (incl. a 375-char Japanese paragraph), 36 pytest, ruff
  clean, typecheck/eslint clean, chunker unit tests pass. Learned: `pyopenjtalk` is sdist-only, so Linux hosts need
  `cmake` + a C++ compiler (documented in README). Follow-up: Korean/Vietnamese/Hebrew exist in misaki but Kokoro v1.0
  has no voices for them and mlx-audio's pipeline rejects those lang codes; optional per-language voice preferences in
  the options page.

- [x] Add German and more languages via new models. (1) kikiri-tts German Kokoro fine-tunes (Victoria, Martin;
  Apache-2.0): Kokoro-format `.pth` converted to MLX on first load into `EURYDICE_CACHE_DIR` (`module.` prefix
  stripped, `parametrizations.weight.original0/1` → `weight_g/weight_v`; key set and shapes identical to upstream);
  German lang_code `d` → espeak `de` registered in mlx-audio's pipeline. Kerstin skipped: only raw training
  checkpoints. (2) Chatterbox multilingual: `mlx-community/chatterbox-8bit`/`-fp16` (not `chatterbox-multilingual-v3`,
  which lacks `conds.safetensors` and so has no built-in voice); text split into ≤300-char sentence groups since one
  call caps at ~40 s. Added `pykakasi` + `spacy-pkuseg` (its ja/zh preprocessing silently skips without them).
  (3) Qwen3-TTS CustomVoice 0.6B/1.7B 8-bit, 9 cross-lingual speakers. Registry generalized into `ModelSpec` families
  with canonical language codes; script detection extended to Hangul/Cyrillic/Arabic/Hebrew/Greek; when the requested
  model can't speak the language, the first model that can is used (same family first) and reported in `X-Model`.
  Verified: synthesis on every path, transcribed with Whisper large-v3-turbo — German from all four models verbatim,
  Korean/Russian (Qwen3), Dutch/Chinese/Japanese/Turkish/Arabic (Chatterbox) correct, all earlier Kokoro languages
  correct. Live server smoke test over HTTP; 46 pytest; ruff clean. Learned: Whisper translates short clips when it
  misdetects the language (Arabic looked like English output until the language was forced). Follow-ups: Hebrew and
  Greek on Chatterbox 8-bit are poor (recognisable only with forced language) — try fp16; Chatterbox/Qwen3 voice
  cloning from reference audio; loaded models are never evicted, so cross-family fallback grows memory.

- [x] Extension follow-ups for the multi-model server. (1) No more hardcoded `af_heart`: the background worker and
  options Test sound leave `voice` out when empty, and the server then uses its default voice if it belongs to the
  model, else the model's first (an explicit unknown voice is still 400). (2) Status bar shows what was used per chunk
  from `X-Language`/`X-Model` ("Reading aloud · Dutch · Chatterbox Multilingual (8-bit)"; model only when the server
  switched), and "Loading model… the first use downloads it" when a chunk takes over 8 s; the options Test sound shows
  the same hint. `X-Language` added to CORS `expose_headers`. (3) Model labels in options summarise long language
  lists ("23 languages", codes → names via `Intl.DisplayNames`), full list in the tooltip. Verified: 49 pytest, ruff
  clean, typecheck/eslint clean, 7 browserless extension tests pass, live server returns 200 with voice `vivian` for
  a voiceless Qwen3 request and exposes `X-Language`. Not verified: the 16 Playwright browser tests (Chromium still
  not installed), so the status bar wording hasn't been seen in a real browser.

- [x] Remove Chatterbox and Qwen3-TTS (user judged both too low quality). Kokoro 82M and the German Kokoro fine-tunes
  are the only models again: dropped the `family`/`cross_lingual` registry fields, Chatterbox segmenting
  (`_split_sentences`), Qwen3 "Auto" language, Hangul/Cyrillic/Arabic/Hebrew/Greek script detection and the
  Chatterbox-only `pykakasi` + `spacy-pkuseg` deps. Kept from the extension follow-ups: voiceless requests (German
  models don't have `af_heart`), the status bar language/model label and slow-load hint, summarised model labels.
  Languages Kokoro doesn't speak (Korean, Russian, Dutch, Arabic, …) are read as the voice's own language again.
  Verified: 43 pytest, ruff clean, typecheck/eslint clean, 7 browserless extension tests. Follow-up: the downloaded
  Chatterbox/Qwen3 weights in `~/.cache/huggingface/hub` were deleted (~7.4 GB).

- [x] Fix the CI pipeline (red on every push since June). Causes: (1) Prettier flagged five `src/` files, now
  formatted (whitespace-only commit); (2) `uv.lock` was gitignored, so CI resolved the newest ruff (0.17.2) instead of
  the local 0.15.20 and its formatter disagreed; the lockfile is now committed; (3) once the job got past Prettier,
  the popup voice test failed because the mock server matched `req.url === '/voices'` exactly while the extension
  requests `/voices?model=…`; the mock now routes on the path, serves Kokoro-shaped voices and `/models`, and sends
  `X-Model`/`X-Language`. Verified locally: all 23 Playwright tests (16 in a real Chromium), 43 pytest, ruff 0.15.20
  and 0.17.2 clean, Prettier/ESLint/typecheck clean. Learned: the local Playwright Chromium 1208 was a broken partial
  extraction, so locally it is symlinked to the complete 1248 build (machine-only workaround).

- [x] Upgrade all dependencies and add Dependabot. Python: `uv lock --upgrade` (fastapi 0.162, uvicorn 0.54,
  mlx-audio 0.6.1, transformers 5.20, huggingface-hub 2.3, ruff 0.17.2, …) and raised the `pyproject.toml` floors to
  match. `preshed` held at 3.0.13 via `constraint-dependencies`: 3.0.14 makes spaCy 3.8.16 fail loading
  `en_core_web_sm` (`OverflowError` in `Tokenizer._flush_specials`), which kills English G2P while unit tests stay
  green. JS: ESLint 10, globals 17, Playwright 1.64, Prettier 3.9 (reformatted two `as` casts), web-ext 10,
  @types/chrome 0.3; TypeScript 6.0.3, not 7, because typescript-eslint 8.72 requires TS < 6.1. TS 6 no longer loads
  `@types/*` by default, so `tsconfig.json` sets `types: ["chrome"]`. Actions: checkout v7, setup-node v7, pnpm v6,
  upload-artifact v7, download-artifact v8, action-gh-release v3, setup-uv v10.3.2 (setup-uv stopped publishing
  major tags in v8, so it must be pinned exactly). pre-commit: ruff v0.17.2 (`ruff` → `ruff-check`), hooks v6.0.0;
  the local ESLint/Prettier hooks were `language: node` and errored on every run, now `language: system`.
  `.github/dependabot.yml`: weekly uv, npm, github-actions and pre-commit updates, minor/patch grouped, TypeScript
  majors ignored. Verified: real Kokoro synthesis (en-US, ja, fr, German Victoria), 43 pytest (42 + 1 skip without
  extras), ruff clean, typecheck/ESLint/Prettier clean, 23 Playwright tests in Chromium, `web-ext build`, all
  pre-commit hooks. Follow-ups: drop the preshed constraint once a fixed release ships; move to TypeScript 7 when
  typescript-eslint supports it; `packageManager` is still pnpm@10.0.0.

## Notes

- Reflection/verification: implemented cross-tab playback ownership, pending content-script audio resolution on stop,
  and Test sound fetch/audio cancellation and release; regenerated extension scripts. `pnpm typecheck`, `pnpm lint:js`,
  `uv run ruff check .`, `uv run ruff format --check --diff .`, and `uv run pytest` pass (18 tests).
  `pnpm format:js:check` flags five existing-style files including untouched `src/chunk-text.ts` and
  `src/popup/popup.ts`; formatting whole files would create unrelated churn. `pnpm test:ext` reached Playwright but 16
  tests could not launch because configured Chromium is missing (6 passed). Follow-up: rerun extension tests after
  Chromium is installed; no functionality follow-up identified.
