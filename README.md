# Notes AI — capture spike

macOS meeting notepad. Capture (Steps 1–6) is proven. **Step 7** is the product backend: Postgres schema, seeded `plans`, internal transcribe, `GET /config`. Spike transcribe stays **dev-only**. No website, Google, Stripe Checkout, or notepad UI yet. Follow `PLAN.md`.

## Layout

- `backend/` — NestJS API (`GET /health`, `GET /config`, Postgres schema). `POST /spike/transcribe` only when `NODE_ENV=development` and `CAPTURE_SPIKE_KEY` is set.
- `frontend/` — Electron debug window + native **Pith Capture Helper** (AVAudioEngine + ScreenCaptureKit)
- `website/` — not created until Step 8

## Prerequisites

- Node.js 22+
- PostgreSQL 16+ (Docker Compose in `backend/` is enough)
- macOS 14.2+ for system audio (older macOS falls back to mic-only)
- Xcode Command Line Tools (`swift`) to build the capture helper
- An OpenAI API key (backend)



## Setup

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

In `backend/.env` set `OPENAI_API_KEY`, `CAPTURE_SPIKE_KEY`, and `DATABASE_URL` (see `.env.example`). Quota caps live in the `plans` table, not in code. Pause / min-listen / upload-retry / WAV chunk length live in backend env and `GET /config`.

Never commit `.env`. `POST /spike/transcribe` is **dev-only** (`NODE_ENV=development` plus `CAPTURE_SPIKE_KEY`). `npm start` in backend sets `NODE_ENV=production` and does not register the spike route.

In `frontend/.env` set:

- `BACKEND_URL=http://localhost:3000`
- `CAPTURE_SPIKE_KEY` — **the same value** as backend (Electron **main** sends `X-Spike-Key`; the window never sees it)

## Run — backend

Start Postgres, then the API:

```bash
cd backend
docker compose up -d
npm install
npm run start:dev
```

`curl http://localhost:3000/health` → `{"ok":true}`

`curl http://localhost:3000/config` → timings from `.env` (`minListenSeconds`, pause, upload retry, WAV chunk).

On boot the API creates tables and seeds `plans` (`free` and `paid`). Price amounts are not stored in code; Stripe price ids stay null until Step 10.

If you already run Homebrew Postgres, create a `pith` database and set `DATABASE_URL` (for example `postgres://localhost:5432/pith`) instead of Docker.

```bash
docker compose exec postgres psql -U pith -c 'SELECT code, max_listening_seconds_per_window, max_notes_per_window FROM plans;'
```

## Run — Electron capture (Step 3)

Keep the backend running. In a second terminal:

```bash
cd frontend
npm install
npm start
```

`npm start` builds the Swift helper, then opens the debug window.

1. Choose English or Spanish in the UI (defaults from macOS language).
2. The level pill is visible immediately (**Listening — not recording**). The **Microphone** line shows the current default input (built-in, AirPods, USB mic, …). Allow **Microphone**. Allow **Screen Recording** — that permission is for **meeting sound** (Zoom / Meet / Teams / YouTube), not to save video or screenshots.
3. If you just granted Screen Recording, click **Start** (it retries system audio). Speak or play something and confirm the **Mic** / **System** bars move. Silent or missing input → those bars stay still.
4. Switch the default input in Sound settings (or unplug AirPods): the name should update and the mic tap should reconnect. If no mic remains, bars stay still and a warning appears. **Start** begins recording. Pause holds both still. **Stop** / **Cancel** end the recording and return to preview (the pill stays).
5. Play something in headphones and say a short phrase, then **Stop**.
6. The mix (16-bit PCM WAV, mono, 16 kHz, `fmt`  + `data` only) is posted to `POST /spike/transcribe`. The transcript appears in the window.

Status should show **System audio: on** when Screen Recording is allowed. If it stays off, the app continues **mic-only** and warns that other people may be missing.

Pause / Resume pauses both sources. Cancel discards the buffer. **Resend last mix** retries STT from memory until you quit (nothing is written into the git repo).

In System Settings → Privacy & Security:

- **Microphone** must include the app that actually records. While you run `npm start` that is often **Electron**. After a packaged install it will be **Pith Capture Helper** / **Pith**.
- **Granola** in that list is the *other* Granola app (the commercial notepad), not this repo. Leave it on if you use that product; it does not grant permission to Pith.
- **Screen & System Audio Recording** is for meeting playback (Zoom / Meet / Teams / YouTube). Grant it to **Electron** or **Pith Capture Helper** the same way.

On first **Start**, macOS should show a Microphone prompt. If **Pith Capture Helper** still does not appear, look for **Electron**.

## WAV encoding

GPT transcribe rejects macOS Voice Memos / QuickTime WAVs that include a `JUNK` chunk. Capture writes a canonical PCM WAV. The backend still runs `canonicalizeWav` as a safety net for fixture uploads.

## Curl still works (Step 2, development only)

From the repo root, with `YOUR_SPIKE_KEY` from `backend/.env`:

```bash
curl -sS -X POST http://localhost:3000/spike/transcribe \
  -H "X-Spike-Key: YOUR_SPIKE_KEY" \
  -F "audio=@./backend/audios/english.wav"
```



## Secrets

Never commit `.env`. See `.env.example` only.

## Capture verification


| Test                                                      | Result                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in Mac mic, system audio on                         | Pass (2026-08-21). Transcript of spoken Spanish + English.                                                                                                                                                              |
| **Headphones (AirPods / Bluetooth), YouTube + own voice** | **Pass** (2026-08-21). ~80 s mix; `micPeak` and `sysPeak` both high. Transcript contained the tester’s speech **and** YouTube speech (block times / “357”). Status: system audio on.                                    |
| Screen Recording **denied** (mic-only fallback)           | **Pass** (2026-08-21). Cursor Screen Recording off. Helper log: TCC declined, `system=0` `sysPeak=0`. UI: system audio off + mic-only warning. Transcript had the tester’s voice only (YouTube missing). App still ran. |
| Selected input name + reconnect on device change (Step 6) | Pass (tester confirmed 2026-08-22). Name updates and tap reconnects; AirPods-in-case then needed a retry fix for format -10868. |


