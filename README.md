# Pith

macOS meeting notepad. Capture (Steps 1–6) is proven. **Steps 7–10** cover the product backend, public website, Google login, and Stripe Checkout. **Step 11** is automated tests and GitHub CI. **Step 12a** is the Electron notepad **shell mockup** (fake workspaces/notes). Spike transcribe stays **dev-only**. Follow `PLAN.md`.

## Layout

- `backend/` — NestJS API (`GET /health`, `GET /config`, `GET /me`, Google auth, Stripe Checkout + webhook). `POST /spike/transcribe` only when `NODE_ENV=development` and `CAPTURE_SPIKE_KEY` is set.
- `frontend/` — Electron **notepad shell** (Step 12a mock) + capture spike (dev) + native **Pith Capture Helper**
- `website/` — public site (Vite + React). No notepad, no capture.

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
cp website/.env.example website/.env
```

In `backend/.env` set `OPENAI_API_KEY`, `OPENAI_TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`), `CAPTURE_SPIKE_KEY`, `DATABASE_URL`, `JWT_SECRET`, and the Stripe keys below (see `.env.example`). Quota caps live in the `plans` table, not in code. Pause / min-listen / upload-retry / WAV chunk length live in backend env and `GET /config`.

Never commit `.env`. `POST /spike/transcribe` is **dev-only** (`NODE_ENV=development` plus `CAPTURE_SPIKE_KEY`). `npm start` in backend sets `NODE_ENV=production` and does not register the spike route.

### Google OAuth (Step 9)

Create **two** OAuth clients in Google Cloud (APIs & Services → Credentials). Do not reuse one client for both.

1. **Desktop** app. Put the client id in `backend/.env` (`GOOGLE_DESKTOP_CLIENT_ID`) and `frontend/.env` (`GOOGLE_DESKTOP_CLIENT_ID`). Put the client secret only in `backend/.env` (`GOOGLE_DESKTOP_CLIENT_SECRET`).
2. **Web** application. Authorized JavaScript origins: `http://localhost:5173`. Authorized redirect URIs: `http://localhost:5173/auth/callback`. Put the client id in `backend/.env` (`GOOGLE_WEB_CLIENT_ID`) and `website/.env` (`VITE_GOOGLE_WEB_CLIENT_ID`). Put the client secret only in `backend/.env` (`GOOGLE_WEB_CLIENT_SECRET`).

Also set `WEBSITE_URL=http://localhost:5173` (backend and frontend). Add your Gmail as a test user on the OAuth consent screen while the app is in Testing.

In `frontend/.env` set:

- `BACKEND_URL=http://localhost:3000`
- `WEBSITE_URL=http://localhost:5173` — Upgrade opens this origin in the **system browser**
- `CAPTURE_SPIKE_KEY` — **the same value** as backend (Electron **main** sends `X-Spike-Key`; the window never sees it)
- `GOOGLE_DESKTOP_CLIENT_ID` — public Desktop client id (the secret stays on the backend)

In `website/.env` set `VITE_API_URL=http://localhost:3000` and `VITE_GOOGLE_WEB_CLIENT_ID`. Displayed USD amounts on Pricing come from `VITE_PRICE_MONTHLY_USD` and `VITE_PRICE_YEARLY_USD` (labels only). Checkout charges the Stripe Price ids, not those display strings.

### Stripe Checkout (Step 10)

Use **test mode**. Create two recurring Prices (USD) — monthly **$7.99** and yearly **$87.99** — then put the Price ids in `backend/.env`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_MONTHLY`
- `STRIPE_PRICE_ID_YEARLY`

On API boot those Price ids are copied onto the `paid` row in `plans`. Caps still come from the `plans` table (`max_listening_seconds_per_window`, `max_notes_per_window`). Changing those SQL columns changes remaining quota on `GET /me` without a code change. `max_notes_per_window = 0` on paid means unlimited notes.

Forward webhooks while developing:

```bash
stripe listen --forward-to localhost:3000/billing/webhook
```

Paste the CLI signing secret into `STRIPE_WEBHOOK_SECRET`. The webhook (`checkout.session.completed`, `customer.subscription.updated` / `deleted`) is what sets `plan_code = paid`. Checkout never runs inside Electron.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

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

On boot the API creates tables and seeds `plans` (`free` and `paid`). Price **amounts** are not stored in code; Stripe Price **ids** come from `STRIPE_PRICE_ID_*` in `.env` and are written onto the paid plan row.

If you already run Homebrew Postgres, create a `pith` database and set `DATABASE_URL` (for example `postgres://localhost:5432/pith`) instead of Docker.

```bash
docker compose exec postgres psql -U pith -c 'SELECT code, max_listening_seconds_per_window, max_notes_per_window FROM plans;'
```

## Run — website (Step 8–10)

```bash
cd website
npm install
npm run dev
```

Open http://localhost:5173. The site is usable without the Mac app. Look is **cream + burnt orange**: pith cream `#FAF7F1`, CTA `#C65A2E`, peach wash on the badge/collage. Headlines are **Sora** (wide geometric, like the wordmark); UI is **Source Sans 3**. Name stays **Pith**.

1. Confirm the landing page (product pitch + **Download for Mac**, which is a placeholder until the installer exists).
2. Open **Pricing**. **Choose monthly** / **Choose yearly** create a Stripe Checkout Session (`POST /billing/checkout-session`) and redirect this browser to Stripe. Sign in first if you have not. Paid users see disabled buttons. Displayed USD amounts come from `website/.env` (`VITE_PRICE_MONTHLY_USD`, `VITE_PRICE_YEARLY_USD`); the charge is the Stripe Price.
3. After a successful test payment, Stripe returns to **Account** (`/account?checkout=success`). Keep `stripe listen` running so the webhook can set `paid`. Account shows remaining minutes and notes from `GET /me`.
4. Copy is **English** or **Spanish** from the browser/OS language (`navigator.languages`). Anything other than Spanish defaults to English. There is no language toggle on the website.
5. **Sign in with Google** opens Google in this browser. The session is an **httpOnly** cookie on the API (`POST /auth/web/callback`). **Sign out** clears it (`POST /auth/logout`). `GET /me` returns the user, `plan` (`free` / `paid`), `planInterval` (`month` / `year` / null), and remaining quota (`Cache-Control: no-store`). While signed in, the header shows your email and plan (Free / Paid monthly / Paid yearly) and an **Account** link.

## Run — Electron (Step 12a shell + capture spike)

Keep the backend running. In a second terminal:

```bash
cd frontend
npm install
npm start
```

`npm start` builds the Swift helper, then opens the **notepad shell**. Workspaces and notes are **mock data** (Step 12a). Google sign-in, plan, remaining time, and Upgrade are the real APIs from Steps 9–10 (shown on **Profile**).

**+ New note** (orange, always in the top bar) opens the original capture spike and **starts recording immediately**. The spike uses the same cream page and pill buttons as the notepad. The screen title is an editable **New note** field. Below it is a borderless notes field with a subtle **Write notes...** / **Escribe tus notas...** placeholder. Controls sit at the bottom: meter → **Stop** / **Resume** → **Generate** → clock. The notepad and New note screens share the same window size. **Stop** pauses; the same button then says **Resume**. **Generate** transcribes the mix and writes it into that same notes field (**My notes:** and typed notes first, then the transcript; transcript only if there were no notes). The field stays scrolled to the top. There is no separate transcript box. A subtle **Home** control returns to the notepad. Top-right **...** → **Move to trash** discards an in-progress listen and returns to the notepad. Sign-in and language stay on **Profile**.

**Sign in with Google** opens the **system browser** (not an embedded webview). Google redirects to `http://127.0.0.1:<port>/callback` so Electron can receive the `code` — that tab is **not** the public website. After the token is stored, Pith comes to the front. The callback tab explains that and tries to close. Electron sends `code` + `codeVerifier` to `POST /auth/electron/callback` and stores the JWT in **safeStorage**. The same Gmail as the website is one `users` row. Website and Electron sessions stay independent (signing in on one does not log the other in). **Profile** shows email, plan, remaining minutes, and the language menu. **Upgrade** (free only, on Profile) opens the website pricing page in the **system browser** — never Checkout in a webview. After you pay, click back to the app (it refreshes `GET /me`). **Sign in** and **Sign out** share the bottom-left of the sidebar (icon + label: green for sign-in, orange for sign-out). Sign out deletes the local token.

This MVP does not use a custom URL scheme (`pith://`), so a browser tab cannot launch the Mac app. Sign in from the app that is already open; after Google, that window is focused.

### Notepad mock (Step 12a)

1. Sidebar order: mock **Search**, **Home**, **Profile**, then **Workspace** and the list. Hover or select a workspace to show **...** → **Delete workspace**. If the workspace still has notes, a dialog explains it must be emptied first. The last workspace cannot be deleted. **+ Add workspace** under the list opens a name field (Enter to save, Escape to cancel). Language is on **Profile**, not the top bar.
2. **Home** shows fake workspaces in a centered fixed-width column. Orange **+ New note** (always in the top bar) opens the original headphone spike. Open a workspace to see mock notes.
3. Notes are grouped by day (Today / date), with an icon, title, and time on the right, in the same centered fixed-width column. Hover or select a note to hide the time and show **...** in that same right slot → **Delete note** (regular weight, not bold). Confirm with **Cancel** or **Delete permanently**. **Processing** notes cannot be deleted. **Failed** notes have **Retry** (mock).

### Capture spike (headphones)

1. Open **+ New note**. Recording starts automatically. The level pill sits to the left of **Stop**. Allow **Microphone**. Allow **Screen Recording** — that permission is for **meeting sound** (Zoom / Meet / Teams / YouTube / Netflix and anything else the Mac plays), not to save video or screenshots. System audio is a **global process tap** (not bound to the headphone device, so switching to AirPods does not rebuild the tap or interrupt playback). YouTube, Netflix, and other apps mix together, tab switches do not restart capture, and DRM video can stay visible. We do **not** use ScreenCaptureKit and we still do not save video. Capture uses the **macOS default microphone**, including AirPods / headset mics in a conference. The headphone jack is never treated as a mic.
2. If you just granted Screen Recording, open **+ New note** again (it retries system audio). Speak or play something and confirm the level bars move. Silent or missing input → those bars stay still.
4. Switch the default input in Sound settings (or unplug AirPods): the name should update and the mic tap should reconnect. If no mic remains, bars stay still and a warning appears. The **HH:MM:SS** clock starts with the listen. **Stop** pauses both sources and the clock; the button becomes **Resume**. **Generate** freezes the clock on the mix length and transcribes. **Move to trash** discards the buffer and returns to the notepad.
5. Play something in headphones and say a short phrase, then **Generate**.
6. The mix (16-bit PCM WAV, mono, 16 kHz, `fmt`  + `data` only) is posted to `POST /spike/transcribe`. Long recordings are split on the server into parts of `WAV_CHUNK_SECONDS` (default 10 minutes, under OpenAI’s 25 MB per-file limit), transcribed in order, then concatenated. The combined text is written into the notes field **after Generate** (**My notes:** first, then the transcript; transcript only if nothing was typed). **Generate** (and **Move to trash**) stop the mic and system-audio tap so capture does not keep running in the background. The **API terminal** prints an estimated STT cost in USD from the transcription `usage` OpenAI returns, times the current list price on that model’s OpenAI docs page (fetched at runtime, not stored in code or `.env`). That estimate is not shown in the app.

If Screen Recording is allowed, system audio is mixed in. If it stays off, the app continues **mic-only** (other people may be missing, especially with headphones).

**Stop** / **Resume** pauses or continues both sources. **Generate** transcribes. **Move to trash** discards the buffer and returns to the notepad. Restarting the Mac app clears the last mix.

In System Settings → Privacy & Security:

- **Microphone** must include the app that actually records. While you run `npm start` that is often **Electron**. After a packaged install it will be **Pith Capture Helper** / **Pith**.
- **Granola** in that list is the *other* Granola app (the commercial notepad), not this repo. Leave it on if you use that product; it does not grant permission to Pith.
- **Screen & System Audio Recording** is for meeting playback (Zoom / Meet / Teams / YouTube). Grant it to **Electron** or **Pith Capture Helper** the same way.

On first **New note**, macOS should show a Microphone prompt. If **Pith Capture Helper** still does not appear, look for **Electron**.

## WAV encoding

GPT transcribe rejects macOS Voice Memos / QuickTime WAVs that include a `JUNK` chunk. Capture writes a canonical PCM WAV. The backend still runs `canonicalizeWav` as a safety net for fixture uploads.

## Curl still works (Step 2, development only)

From the repo root, with `YOUR_SPIKE_KEY` from `backend/.env`:

```bash
curl -sS -X POST http://localhost:3000/spike/transcribe \
  -H "X-Spike-Key: YOUR_SPIKE_KEY" \
  -F "audio=@./backend/audios/english.wav"
```



## Tests (Step 11)

From the repo root:

```bash
npm test
```

That runs `scripts/test-all.sh`: backend tests + typecheck, website tests + typecheck, frontend typecheck. Postgres must be running (`cd backend && docker compose up -d`). The suite uses a separate database `pith_test` (created on first run if missing). It does **not** call Google, Stripe Checkout, OpenAI, or capture hardware. Dummy values live in `backend/.env.test` (safe to commit).

You can still run a single project:

```bash
cd backend && npm test && npm run typecheck
cd website && npm test && npm run typecheck
cd frontend && npm run typecheck
```

GitHub Actions (`.github/workflows/test.yml`) runs the same root `npm test` on every **push** and **pull request**. There is no git hook that blocks a push.

Headphone mix, real OAuth, and live Checkout stay manual (see capture verification below).

## Secrets

Never commit `.env`. See `.env.example` only.

## Capture verification


| Test                                                      | Result                                                                                                                                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in Mac mic, system audio on                         | Pass (2026-08-21). Transcript of spoken Spanish + English.                                                                                                                                                              |
| **Headphones (AirPods / Bluetooth), YouTube + own voice** | Re-test (2026-09-11): default input follows AirPods; global tap stays up so playback is not torn down. |
| Screen Recording **denied** (mic-only fallback)           | **Pass** (2026-08-21). Cursor Screen Recording off. Helper log: TCC declined, `system=0` `sysPeak=0`. UI: system audio off + mic-only warning. Transcript had the tester’s voice only (YouTube missing). App still ran. |
| Selected input name + reconnect on device change (Step 6) | Pass (tester confirmed 2026-08-22). Name updates and tap reconnects; AirPods-in-case then needed a retry fix for format -10868. |


