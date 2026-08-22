# Notes AI — capture spike

macOS meeting notepad. Headphone system audio and mic-only fallback are proven (**Step 5 pass**). **Next:** Step 4 (live level indicator), then Step 6 (reconnect the tap). No website, Google, Stripe, or notepad UI yet. Follow `PLAN.md`.

## Layout

- `backend/` — NestJS API (`GET /health`, `POST /spike/transcribe`)
- `frontend/` — Electron debug window + native **Pith Capture Helper** (AVAudioEngine + ScreenCaptureKit)
- `website/` — not created until Step 8

## Prerequisites

- Node.js 22+
- macOS 14.2+ for system audio (older macOS falls back to mic-only)
- Xcode Command Line Tools (`swift`) to build the capture helper
- An OpenAI API key (backend)



## Setup

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

In `backend/.env` set `OPENAI_API_KEY` and `CAPTURE_SPIKE_KEY`.

In `frontend/.env` set:

- `BACKEND_URL=http://localhost:3000`
- `CAPTURE_SPIKE_KEY` — **the same value** as backend (Electron **main** sends `X-Spike-Key`; the window never sees it)

Never commit `.env`. `POST /spike/transcribe` is **dev-only**.

## Run — backend

```bash
cd backend
npm install
npm run start:dev
```

`curl http://localhost:3000/health` → `{"ok":true}`

## Run — Electron capture (Step 3)

Keep the backend running. In a second terminal:

```bash
cd frontend
npm install
npm start
```

`npm start` builds the Swift helper, then opens the debug window.

1. Choose English or Spanish in the UI (defaults from macOS language).
2. Click **Start**. Allow **Microphone**. Allow **Screen Recording** — that permission is for **meeting sound** (Zoom / Meet / Teams / YouTube), not to save video or screenshots.
3. If you just granted Screen Recording, click **Start** again.
4. Play something in headphones and say a short phrase, then **Stop**.
5. The mix (16-bit PCM WAV, mono, 16 kHz, `fmt`  + `data` only) is posted to `POST /spike/transcribe`. The transcript appears in the window.

Status should show **System audio: on** when Screen Recording is allowed. If it stays off, the app continues **mic-only** and warns that other people may be missing.

Pause / Resume pauses both sources. Cancel discards the buffer. **Resend last mix** retries STT from memory until you quit (nothing is written into the git repo).

In System Settings → Privacy & Security:

- **Microphone** must include the app that actually records. While you run `npm start` that is often **Electron**. After a packaged install it will be **Pith Capture Helper** / **Pith**.
- **Granola** in that list is the *other* Granola app (the commercial notepad), not this repo. Leave it on if you use that product; it does not grant permission to Pith.
- **Screen & System Audio Recording** is for meeting playback (Zoom / Meet / Teams / YouTube). Grant it to **Electron** or **Pith Capture Helper** the same way.

On first **Start**, macOS should show a Microphone prompt. If **Pith Capture Helper** still does not appear, look for **Electron**.

## WAV encoding

GPT transcribe rejects macOS Voice Memos / QuickTime WAVs that include a `JUNK` chunk. Capture writes a canonical PCM WAV. The backend still runs `canonicalizeWav` as a safety net for fixture uploads.

## Curl still works (Step 2)

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


