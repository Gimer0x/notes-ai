# Granola-like MVP — plan

This file is the source of truth for the product and for how Cursor should build it. Follow it. Do not generate code until a human asks to implement a specific step. Do not invent answers to **Still open**. If a step depends on one, stop and ask.

## Product

A **public website** (download, Google login, pricing, Stripe Checkout) plus a **macOS Electron app** (notepad). The user signs in with Gmail (default **free**), can add **multiple workspaces**, presses **New note**, and the app listens to the meeting by mixing:

- the **laptop microphone** (your voice)
- **system audio** (what Zoom / Meet / Teams plays — other people, including over headphones)

It does **not** join as a bot, does **not** capture screen or video, and does **not** install a virtual audio driver. Apple may still show a **Screen Recording** permission because that is how macOS gates “hear other apps”; the app must not save any video or screenshots.

When the user **stops** listening (after 30 seconds of audio), audio is **not kept**. OpenAI **GPT STT** then **GPT** numbered bullets; store the summary only. Meetings and summaries are **English or Spanish**; bullets are written in the **same language as the meeting**.

Paid access is a real **Stripe Checkout** subscription (**$7.99/month** or **$87.99/year**). **Currency is always USD**. Checkout runs in the **system browser** and returns to the **website**. Free users are not blocked; they are capped. Yearly subscribers still get **100 hours per month**, not 100 hours per year.

## Constraints (always)

1. **Three projects by the end:** `backend/`, `website/`, `frontend/` (Electron). **Start with `backend/` + `frontend/` only** until capture is proven (Steps 1–5). Add `website/` in Step 8.
2. Never expose secrets. dotenv + `.env`. Commit `.env.example` only. `.env` in `.gitignore`.
3. Do not over-engineer. SOLID. Reusable modules (auth, workspaces, notes, listening, summarization, billing).
4. First ship is **macOS** (`.dmg` / `.zip`). **Prepare** electron-builder for a future Windows `.exe`. Do not build, test, or ship Windows in this MVP.
5. TypeScript everywhere.
6. **Stripe Checkout is in this MVP**, isolated in the billing module. Notes, listening, and auth must not import Stripe. They ask billing for plan + remaining quota only.
7. **Never embed Stripe Checkout in an Electron webview.** Create the session on the server; open it in the **system browser**. Success/cancel URLs are on the **website**.
8. Every feature that lands must update `README.md`.
9. Gmail is **login only**. No mail, calendar, or contacts.
10. **GPT only** for STT and summarization (OpenAI).
11. **USD only.** Do not add other currencies or localized prices in this MVP.
12. Meeting languages: **English and Spanish only.** Detect the meeting language; write the bullet summary in that language. Do not add other languages.
13. Do not implement organizations, team seats, or Windows installers beyond the preparation below.
14. **Capture** is a dedicated desktop module in Electron **main** (Swift helper or native addon — not the renderer). **macOS 14.2+:** **AVAudioEngine** for the microphone, **ScreenCaptureKit** for system audio (**audio only** — no video frames, no screenshots). Mix both to 16-bit PCM mono 16 kHz. Do **not** use Core Audio process taps, AVCapture for the meeting, or a virtual driver. Older OS → mic-only + warning.

## Checkout strategy (locked)

**Pay on the website, not inside the Mac app.**

| Surface | Does | Does not |
| --- | --- | --- |
| **Website** | Landing, download Mac app, Google sign-in / sign-out, pricing (monthly vs yearly), start Checkout, success/cancel pages, account (plan + remaining quota) | Microphone, notes, workspaces |
| **Electron** | Sign-in, workspaces, listening (mic + system audio), notes, remaining time, **Upgrade** button | Host Checkout UI; record screen/video |
| **Upgrade in Electron** | Opens the system browser to the website pricing/Checkout flow | In-app payment form |

After Stripe Checkout, the user lands on the **website** account/success page. They can close the Checkout tab. A **webhook** marks the user `paid`. Electron **refetches** plan/quota (same Google user). Sessions do not need to be shared between website and Electron — only the same Google account.

This is the right split: Stripe is built for the browser; the website can convert before install; Electron stays a notepad.

## MVP requirements

### Website, accounts, billing

1. Public **website**: product pitch, **download** the Mac app, Sign in / Sign out with Google.
2. First Google login (website or Electron) creates the user with plan **`free`**. Stripe is not required to use the app.
3. Product plans: **`free`** and **`paid`**. Paid is sold as two Stripe Prices:
   - **$7.99 USD / month**
   - **$87.99 USD / year**
   User picks on the website pricing page. Store Price ids in the `plans` row / env — **do not hard-code dollar amounts** in the client. Amounts live in the Stripe Dashboard. Checkout and Prices are **USD only**.
4. To become `paid`, complete **Stripe Checkout** (subscription). A **webhook** (not the client) sets `plan_code = paid`, `stripe_customer_id`, `stripe_subscription_id`, and period dates.
5. Limits live in the **`plans` table** (admin changes them in SQL; no admin UI).
6. **Free (seed):** 60 minutes listening per **quota window**, 30 minutes max **per note**, **10 notes** per window.
7. **Paid (seed):** 100 hours listening per **quota window**, unlimited notes, **no** per-note cap.
8. **Quota windows:**
   - **Free:** rolling **30 days from signup** (`users.created_at`). When a window ends, start the next 30 days and reset usage. Not a UTC calendar month.
   - **Paid monthly:** Stripe subscription `current_period_start` → `current_period_end` (the billing cycle).
   - **Paid yearly:** the customer pays once a year, but the allowance is still **100 hours every month** (same as monthly paid). Do **not** use a single 100-hour yearly bucket. Reset paid usage every month on the **subscription anniversary day** (same day-of-month as `current_period_start`), while the subscription is active.
9. Show **remaining listening time** on the website account page, Electron home, and during a session (plus remaining notes on free).
10. Enforce quotas before New note and before OpenAI. Auto-stop at per-note max (free only) or when remaining minutes hit 0.
11. Checkout success URL: website page (account / “you’re paid — you can close this tab”). Cancel URL: website pricing. Test mode is fine in development.

### Workspaces and notes

12. **Multiple workspaces per user.** User can add more. Flat list, **no nested folders**. Notes belong to one workspace. Move note = change workspace.
13. After login, Electron shell:
    - **Left:** Home + workspace list (add workspace).
    - **Right:** current workspace name + notes.
14. Each note row: **name**, **date**, **time**. Open = saved summary.
15. Move to another workspace. Delete/cancel a note only after confirm. **Cannot** delete a note while `processing`.
16. **Delete workspace:** only if it has **zero notes**. **Cannot** delete the user’s **last** workspace even if empty.

### Listening and summary

16. Not intrusive: no bot in Zoom / Meet / Teams.
17. **Capture both sides of the call** in the first Mac MVP:
    - **Microphone** → the user’s voice
    - **System audio** → meeting playback (speakers or headphones)
    - Mix into **one** buffer. Send that buffer on Stop (same as today). No live captions, no speaker names.
18. If system-audio permission is **denied** or the OS is too old: fall back to **mic only** and show a clear warning that the other participants may be missing (especially with headphones). Do not block starting a note.
19. Request **Microphone** and, for system audio, macOS **Screen Recording** (audio tap only — never record or store video/screen). Explain in the UI that the permission is for meeting sound, not screen recording.
20. **One listening session per user at a time.**
21. Several notes may `processing` in the background. Home must not cancel jobs.
22. **New note:** optional **title**; if blank, after GPT set title to the **first bullet**.
23. Controls: **Pause / Resume** and **Stop**. Pause pauses **both** sources; paused time does not count toward 30 s. **Auto-cancel (discard) after 20 minutes paused.** Show remaining pause time; warn at 1 minute left. No confirm if they walked away.
24. **Minimum: 30 seconds** of captured audio. Stop early → **Resume** or **Cancel** (confirm, discard). No GPT, no empty summary.
25. Stop ≥ 30 s → upload mix (`POST /notes/:id/stop`). If offline, **keep buffering** while listening. On Stop, **retry upload for 10 minutes**, then **warn and discard** the audio. **Quit the app** with an unsent buffer → discard and `POST /notes/:id/cancel`. Never leave a WAV in temp overnight.
26. After upload: keep the mix in job storage **only until STT succeeds**, then delete audio and save `transcript_text`. Then GPT bullets. If STT fails while WAV still exists, Retry can re-run STT. If GPT fails, Retry re-runs GPT on the stored transcript. If there is no transcript and no audio → no Retry; user records again.
27. Auto-stop at free 30 min/note and when remaining window minutes hit 0 (process if ≥ 30 s, else early-stop prompt).
28. Languages: **English and Spanish** only. STT must handle both. The bullet summary must be in the **same language as the meeting** (detect from the audio/transcript; if mixed, use the dominant language). Do not translate into the other language unless the meeting was in that language.
29. Summary: numbered bullets of important ideas and topics, for example:
    1. The UX will be changed by Bob
    2. The client did not like the presentation
    3. …

### Note statuses (required)

| Status | Meaning | Delete / cancel |
| --- | --- | --- |
| `listening` | Mic + system audio on (or mic-only fallback) | Cancel after confirm (discard) |
| `paused` | Both sources paused, buffer kept | Cancel after confirm (discard) |
| `processing` | STT + GPT running | **No** |
| `ready` | Summary saved | Yes, after confirm |
| `failed` | `error_code`: `upload` \| `stt` \| `gpt` | Yes, after confirm. **Retry** if audio (STT) or transcript (GPT) still exists |

## Tech stack (decided)

| Piece | Choice | Why |
| --- | --- | --- |
| Public site | **`website/`** React + TypeScript | Download, auth, pricing, Checkout return, account |
| Desktop | **`frontend/`** Electron + React + TypeScript + **native macOS capture** | Mix mic + system audio; notepad |
| Backend | **`backend/`** NestJS + TypeScript | Auth, CRUD, jobs, Stripe, OpenAI |
| Database | **PostgreSQL** | Users, plans, workspaces, notes, usage |
| Jobs | Postgres-backed jobs first | Stop returns immediately |
| Auth | Google OAuth 2.0 (website + Electron; same user by Google subject) | Gmail login only |
| STT | OpenAI transcription (e.g. `gpt-4o-mini-transcribe`) | GPT family |
| Summary | OpenAI GPT; numbered-bullet prompt | GPT only |
| Payments | Stripe Checkout (hosted) + webhook | $7.99/mo and $87.99/yr |
| Installer | electron-builder mac ships; win target configured, not built | Future `.exe` |
| Secrets | Each project `.env` | Never commit real values |

Do not add: meeting plugins, calendar sync, local Whisper, Redis/Kubernetes unless a step fails without them, Nx/Turborepo, Checkout inside Electron, virtual audio drivers, screen/video recording, live captions, speaker diarization.

## Data model (logical)

Keep this shape. Table names may differ; relationships must not.

### `plans` (admin-configured; seed two rows)

- `code`: `free` \| `paid`
- `max_listening_seconds_per_window` (free: `3600`; paid: `360000` = 100 hours)
- `max_seconds_per_note` (free: `1800`; paid: `null`)
- `max_notes_per_window` (free: `10`; paid: `0` = unlimited)
- `stripe_price_id_monthly` (null on free; Stripe Price for $7.99/mo)
- `stripe_price_id_yearly` (null on free; Stripe Price for $87.99/yr)
- timestamps

### `organizations` (prepare only)

- `id`, `name`, timestamps
- No UI, invites, org billing, or memberships in this MVP.

### `users`

- `id`, Google subject, email, display name
- `plan_code` → `plans.code`, default `free`
- `stripe_customer_id`, `stripe_subscription_id` (nullable)
- `stripe_price_id` (which price they subscribed to)
- `subscription_period_start`, `subscription_period_end` (from Stripe; paid only)
- `organization_id` (nullable FK) — **unused in product logic**
- timestamps (`created_at` starts the first free 30-day window)

### `usage_windows` (quota meter)

- `user_id`, `period_start`, `period_end`
- `listening_seconds_used`, `notes_counted`
- unique (user_id, period_start)

Resolve the active window from plan rules above (free 30-day slices vs Stripe monthly vs yearly-with-monthly-resets).

### `workspaces`

- `id`, `user_id`, `name`, timestamps

### `notes`

- `id`, `workspace_id`, `user_id`, `title`, `status`, `summary_text`, `transcript_text` (nullable; set after STT succeeds), `language` (`en` \| `es`), `error_code` (`upload` \| `stt` \| `gpt`, nullable), `error_message` (nullable), `started_at`, `ended_at`, `duration_seconds`, timestamps
- Keep mixed WAV in **job temp only until STT succeeds**, then delete. Do not persist audio on the note. Persist `transcript_text` so GPT can be retried.

**Note counting (free, 10 / window):** Count notes created in the current window that were not discarded by cancel while `listening`/`paused`. Deleted `ready`/`failed` notes **still count**. `processing` counts.

## Future preparation (do not implement now)

### Organizations

- `organizations` + `users.organization_id` only.
- Later: `memberships`, org-level Stripe, shared workspaces. Not now.

### Windows `.exe`

- electron-builder **win** target in config; do not run it.
- Capture (mic + system audio) behind a small **platform module** (mac implementation in this MVP; Windows later).
- README: Windows planned; this release is macOS.

## UX flow (happy path)

1. User opens the **website** → Sign in with Google → `free`. Can **download** the Mac app. Can **Upgrade** (monthly or yearly) → Stripe Checkout in the browser → success page on the website → close Checkout tab. Webhook sets `paid`.
2. Open **Electron** → Sign in with the same Google account → plan and remaining time from API.
3. Home: remaining minutes (and notes left if free), Upgrade (opens browser if free), workspace list. User **adds workspaces** as needed.
4. Select a workspace. **New note** → optional title → quota check → request mic + system-audio permission → listen (mixed). Pause / Resume / Stop. Remaining time on screen. If system audio is denied, warn and continue with mic only.
5. Stop < 30 s → Resume or Cancel. Stop ≥ 30 s → `processing` → GPT → `ready`.
6. Electron Upgrade always uses the browser + website return. Never in-app Checkout.

## Implementation plan

**Risk-first.** System-audio capture is the hardest part. Do **not** build Google, Stripe, workspaces, notes, or the public website until a headphone meeting (or YouTube in headphones) appears in a transcript. If capture fails, stop; do not continue the product on a mic-only hope.

Implement **in this order**. Each step must compile, use `.env`, follow SOLID, and update `README.md`. Do not start step N+1 until step N works.

**Status:** Steps 1–7 are implemented. Confirm Postgres seed + `GET /config` before Step 8. Website is Step 8.

### Module boundaries

- **Capture** — Electron **main** only: **AVAudioEngine** (mic) + **ScreenCaptureKit** (system audio, no video) → mix to 16-bit PCM mono 16 kHz. Renderer never talks to SCK or Core Audio.
- **Transcribe (spike)** — NestJS: accept one audio blob, call OpenAI STT, return text. No notes DB. Used to prove capture. Curl-friendly.
- **Auth / Billing / Workspaces / Notes / Summarization (bullets)** — only after capture is proven (after Step 5). Device-tap reconnect is Step 6; product backend starts at Step 7.

### Interface contracts (locked)

These are the agreements between modules. Implement to these shapes. Do **not** rename methods, HTTP paths, or JSON fields. The React UI never imports ScreenCaptureKit, Stripe, or OpenAI.

Audio on the wire is always **16-bit PCM WAV, mono, 16 kHz**. HTTP paths stay as in **Backend API contract** below (`/auth/electron/callback`, `/notes/:id/stop`, `GET /me` — not `/auth/google/exchange`, `/notes/:id/upload`, or `/billing/quota`).

#### 1. Capture (Electron main → renderer)

Renderer talks only to this. Native SCK / AVAudioEngine stay behind it.

```
CaptureService
  preview(): Promise<{ systemAudioEnabled: boolean; inputName: string }>
  start(): Promise<{ systemAudioEnabled: boolean; inputName: string }>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<CapturedAudio>
  cancel(): Promise<void>
  getState(): 'idle' | 'listening' | 'paused'
  subscribeLevels(listener: (levels: CaptureLevels) => void): () => void
  subscribeDevice(listener: (device: CaptureDevice) => void): () => void

CapturedAudio
  filePath: string          // temp WAV, 16-bit PCM mono 16 kHz
  durationSeconds: number

CaptureLevels
  mic: number               // 0..1 live RMS; 0 if no mic / silent / undetected
  system: number            // 0..1 live RMS; 0 if system audio off / silent

CaptureDevice
  inputName: string         // macOS default input name (AirPods, USB mic, built-in, …)
```

Guarantees: mixes mic + system audio (or mic-only if `systemAudioEnabled` is false). `preview()` opens the mic and system-audio taps for live levels only (no WAV buffer). `start()` begins recording into the mix. `stop()` returns **one** WAV (product HTTP layer splits by `WAV_CHUNK_SECONDS`) and returns to preview. `cancel()` and successful upload delete the temp file. Never write into the git repo. `pause` auto-cancel timing comes from `GET /config`, not from this module. `subscribeLevels` fires while previewing or recording (and may fire at 0,0 while paused). `subscribeDevice` fires whenever the selected default **input** name is known or changes (preview, Start, and live device change). Do **not** rename existing methods.

#### 2. Auth (Electron ↔ backend)

Flow: Electron opens the **system browser** → Google OAuth **PKCE** → redirect `http://127.0.0.1:<port>/callback` → Electron sends `code` + `code_verifier` to the backend → JWT in `safeStorage`.

```
AuthService (Electron)
  login(): Promise<void>
  logout(): Promise<void>
  getAccessToken(): Promise<string | null>
```

`POST /auth/electron/callback` body: `{ code, codeVerifier }`. Returns `{ accessToken }`.  
`GET /me` returns the user (see Billing). Website uses a **Web** OAuth client and httpOnly cookies, not this PKCE client.

#### 3. Audio upload (product notes)

After `CaptureService.stop()`, if `durationSeconds` ≥ `MIN_LISTEN_SECONDS` from config:

`POST /notes/:id/stop`  
`Content-Type: multipart/form-data`  
Authorization: Bearer JWT

| Field | Type |
| --- | --- |
| `durationSeconds` | number (total mix) |
| `audio` | one or more WAV files, **in order**, each ≤ `WAV_CHUNK_SECONDS` |

Response: `{ status: 'processing' }` (202). Do not wait for GPT. Spike still uses `POST /spike/transcribe` with a **single** `audio` file and `X-Spike-Key` only.

#### 4. STT and summary (backend internal)

Two services. Notes and Retry call these; they never call Stripe. Frontend never calls OpenAI.

```
TranscribeService
  transcribe(wavPaths: string[]): Promise<{ language: 'en' | 'es'; transcript: string }>

SummaryService
  summarize(transcript: string, language: 'en' | 'es'): Promise<{ bullets: string[] }>
```

Job: transcribe all parts in order → concatenate `transcript` → save `transcript_text` → delete WAV → `summarize` → save bullets as `summary_text`, status `ready`.  
Retry: STT if WAV still in job temp; else GPT if `transcript_text` is set.  
`GET /notes/:id` (client) includes `status`, `summaryText` (string[] or newline bullets), `language`, `errorCode` — **not** a combined STT+summary POST body to the client.

#### 5. Billing (notes must not import Stripe)

```
BillingService (backend)
  getStatus(userId): Promise<{
    plan: 'free' | 'paid'
    remainingSeconds: number
    remainingNotes: number | null   // null = unlimited
  }>
  canStartNote(userId): Promise<{ allowed: boolean; reason?: string }>
```

HTTP: **`GET /me`** includes `plan`, `remainingSeconds`, `remainingNotes` (do not add `/billing/status` or `/quota`).  
`POST /billing/checkout-session` body `{ interval: 'month' | 'year' }` returns `{ url }`.  
`POST /billing/webhook` is Stripe-only.  
Before `POST /workspaces/:id/notes`, the notes module calls `canStartNote`. If `allowed` is false, 403 with `reason`.

### Backend API contract (locked)

Do not invent different paths. No OpenAPI required. JSON unless noted. Product routes need a logged-in user (JWT or website cookie). Spike routes do not.

**Spike (Steps 2–6 only; dev-only)**

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `POST /spike/transcribe` | One 16-bit PCM WAV (mono, 16 kHz) → `{ text, language }`. Header `X-Spike-Key`. Never call this from the product notes flow. |

**Product (from Step 7 on)**

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `POST /auth/electron/callback` | PKCE `code` + `code_verifier` → JWT |
| `GET /me` | Current user, plan, remaining quota (minutes and notes) |
| `GET /config` | App timings (seconds): min listen, pause auto-cancel, pause warning, upload retry, WAV chunk length. Electron must use this; do not hard-code. |
| `GET /workspaces` | List workspaces |
| `POST /workspaces` | Create workspace |
| `DELETE /workspaces/:id` | Delete if **empty** and **not** the user’s last workspace |
| `GET /workspaces/:id/notes` | List notes in a workspace |
| `POST /workspaces/:id/notes` | Create note (`listening`) |
| `POST /notes/:id/stop` | Upload mixed audio as **one or more** 16-bit PCM WAV parts (mono, 16 kHz, **≤ 10 minutes each**); enqueue STT per part, concatenate text, then GPT bullets (`processing`) |
| `POST /notes/:id/cancel` | Discard while `listening` / `paused` |
| `GET /notes/:id` | Note detail / summary |
| `PATCH /notes/:id` | Rename |
| `POST /notes/:id/move` | Change workspace |
| `DELETE /notes/:id` | Delete if not `processing` |
| `POST /notes/:id/retry` | If `failed`: retry STT when WAV still in job temp; else retry GPT when `transcript_text` exists; else 409 (record again) |
| `POST /billing/checkout-session` | Create Stripe Checkout URL (monthly or yearly) |
| `POST /billing/webhook` | Stripe → set `paid` (Stripe signature; no user JWT) |

Note status lives on the note (`listening` \| `paused` \| `processing` \| `ready` \| `failed`). Do not add a separate session resource.

### Configurable timings and limits (do not hard-code)

Quota caps (60 min / 10 notes / 30 min per note / 100 paid hours) live in the **`plans` table** (SQL), not in source.

Behavior timings live in **backend env** (documented in `backend/.env.example`). Nest `ConfigService` reads them. **`GET /config`** returns them so Electron/website never embed `20 * 60 * 1000`. Changing `.env` (or later a settings table) is enough; no code change.

| Env key (illustrative) | Default for MVP | Meaning |
| --- | --- | --- |
| `MIN_LISTEN_SECONDS` | `30` | Below this, Stop → Resume or Cancel |
| `PAUSE_AUTO_CANCEL_SECONDS` | `1200` (20 min) | Discard if paused this long |
| `PAUSE_WARNING_SECONDS` | `60` | Warn before auto-cancel |
| `UPLOAD_RETRY_SECONDS` | `600` (10 min) | Retry Stop upload while offline, then discard |
| `WAV_CHUNK_SECONDS` | `600` (10 min) | Max length of each WAV part for STT |

Do not scatter these numbers in React, Swift, or Nest handlers. Audio sample rate **16 kHz** / mono / 16-bit stay locked (format, not a business knob).

### Audio format (locked)

- **Mix in the app:** 16-bit PCM, **mono**, **16 kHz**. Downsample/mix to this; do not keep 48 kHz stereo.
- **WAV container (locked):** canonical RIFF/WAVE with **only** `fmt ` and `data` chunks (PCM format tag `1`). Do **not** write `JUNK`, `bext`, `iXML`, or other extra chunks. macOS Voice Memos / QuickTime / some `AVAudioFile` exports insert a `JUNK` chunk; GPT transcribe (`gpt-transcribe`, `gpt-4o-mini-transcribe`) rejects those files as `unsupported_format`. Write the mix ourselves; do not upload a Finder/QuickTime WAV unchanged.
- **Spike:** upload **one** WAV of that PCM (`POST /spike/transcribe`). Clips are short; no chunking. Backend `canonicalizeWav` rewrites uploads to `fmt ` + `data` as a safety net for fixture files.
- **Product (`POST /notes/:id/stop`):** same WAV encoding. Split into parts of at most **`WAV_CHUNK_SECONDS`** (default 10 minutes). STT each part in order, concatenate transcripts, **one** GPT bullet pass. No ffmpeg/MP3/WebM/AAC in this MVP.
- Keep WAV in job temp **until STT succeeds**, then delete. Retry upload on Stop for **`UPLOAD_RETRY_SECONDS`** (default 10 minutes), then discard. Do not persist WAV after quit or after that window.

### How to verify (until Step 5 is green)

- Backend: `curl` against `/health` and `POST /spike/transcribe` with a **fixture wav** (no Electron required).
- Capture: Electron debug window → mix → POST the same endpoint. Success = transcript contains **other people’s words** (or the YouTube voice), not only you, while wearing **headphones**.

---

### Step 1 — Repository layout (capture slice only)

**Do:** Create `backend/` (NestJS) and `frontend/` (Electron + TypeScript). Root `.gitignore` (`node_modules`, dist, `.env`, debug audio). `backend/.env.example` and `frontend/.env.example`. Short root `README.md`: how to run the spike. electron-builder win target listed, not built.

**Do not:** Create the marketing `website/` yet. No Postgres, Google, Stripe, or notepad UI.

**Done when:** `cd backend` starts; Electron opens a blank window.

---

### Step 2 — Backend: health + transcribe API (curl-first)

**Do:** NestJS, env, CORS for localhost / Electron. **No database.**

- `GET /health` → `{ "ok": true }`
- `POST /spike/transcribe` — multipart file (wav/webm/mp3). Header `X-Spike-Key: <CAPTURE_SPIKE_KEY>`. Calls OpenAI STT. Returns JSON `{ "text", "language" }` (`en` or `es` if detectable). Delete the upload from memory when the response is sent.

**Env:** `OPENAI_API_KEY`, `CAPTURE_SPIKE_KEY` (long random string, `.env` only).

**Verify with curl** (fixture file on disk, not from the mic):

- Missing/wrong key → 401
- Valid key + short English wav → 200 and `text` is non-empty
- Document the exact curl in README

**Do not:** Google, Stripe, users, quotas, bullet summaries, persist audio.

**Done when:** A teammate can transcribe a local wav using only curl and `.env`.

---

### Step 3 — Capture module (mic + system audio)

**Do:** One module in Electron **main** (native macOS):

- Request **Microphone** and **Screen Recording** (SCK audio tap only — no video/frames/screenshots). UI copy: meeting *sound*, not the screen.
- **macOS 14.2+:** **AVAudioEngine** for microphone, **ScreenCaptureKit** for system audio (`capturesVideo` / video output **off**). Mix to 16-bit PCM, mono, 16 kHz; encode a **canonical WAV** (`fmt ` + `data` only — no `JUNK` or other extra chunks) for upload. Pause / Resume / Stop both sources.
- Do **not** use Core Audio process taps, BlackHole, or a second system-audio API.
- On Stop, POST the mix to `POST /spike/transcribe` with the spike key (key stays in Electron **main** env, never in the renderer)
- Minimal **debug window**: Start, Stop, status (system audio on / denied / mic-only), and the returned transcript
- Denied or old OS: mic-only + warning. No BlackHole / virtual mixer
- Optional **debug-only**: keep the last mix in memory until Quit so you can re-send; never write a lasting recording into the project or git. If a temp file is required, delete it on Stop and on quit; path under OS temp, not the repo

**Do not:** Workspaces, login, quotas, 30 s product rule (spike may be shorter), GPT bullets, website.

**Done when:** Debug window can start/stop; permission prompts appear; mix is posted; transcript prints in the window.

---

### Step 4 — Live level indicator (debug window)

**Do:** Show a compact **Granola-style** pill in the existing Electron debug window as soon as the window opens: a few vertical green bars driven by **live RMS** from the capture helper (not a looping CSS animation). Bars must reflect real signal from the microphone and/or system-audio tap. **Start** begins recording; before that the taps are preview-only (levels, no WAV).

- Call `CaptureService.preview()` when the debug window loads so levels run without recording. Keep the pill visible while idle, recording, and paused. Stop / Cancel return to preview (do not hide the pill).
- Stream levels from the helper → Electron main → renderer (`CaptureService.subscribeLevels`). `mic` and `system` are each `0..1`.
- **If the microphone is not detected, missing, or silent:** the mic-driven bars **must not move**. Do not fake activity.
- **If system audio is off, denied, or silent:** those bars stay still. Mic bars may still move if the mic has signal.
- While **paused**, bars stay still (levels at 0). Resume starts motion again only if a source has signal.
- EN/ES copy for any new status text (same i18n files as the debug window).

**Do not:** Change the mix format or STT. Do not start the headphone gate write-up (already Step 5). Do not reconnect devices (Step 6). No website, Postgres, Google, or Stripe.

**Done when:** The pill is visible before Start; speaking into a working mic moves the bars; mute/unplug/no-mic leaves them still; system audio with playback can move system bars; Start records; Stop transcribes and the pill stays up.

---

### Step 5 — Prove it on headphones (gate)

**Do:** Manual test, then write the result in README (`Capture verification`):

1. Headphones on (not speakers).
2. Play a spoken YouTube/Meet/Zoom on the Mac.
3. Speak a unique phrase yourself (“alpha test one two three”).
4. Capture 20–40 s, Stop, read transcript.
5. **Pass:** transcript contains **both** the other audio **and** your phrase.
6. Repeat with Screen Recording **denied**: transcript has you, warning shown, other side missing or weak. App still runs.

If checklist item 5 fails, **stop the project plan here** and fix capture. Do not start Step 7.

**Done when:** README records a pass on headphones for system audio + a pass for mic-only fallback.

---

### Step 6 — Reconnect the tap on device change + show selected input

**Do:** If the default input (or system-audio route) **disconnects or changes** during preview or a listen, **reconnect the tap** to the new default device and keep mixing (or keep previewing). Today the helper binds the default input once and does not rebind; a mid-session unplug can go silent.

Also **show the selected microphone name** in the debug window (the macOS default input: built-in **MacBook Pro Microphone**, **Bluetooth AirPods**, USB / external mic, etc.). Update that label whenever the default input changes.

- Detect configuration / device-change while previewing, `listening`, or `paused`.
- Re-attach the mic tap (and system tap if it was enabled) to the current default. Do not restart the whole note or discard the buffer already captured.
- If reconnect fails (no input device), keep the session, set mic level to 0, clear or show a “no microphone” name, and show a short EN/ES warning that the microphone was lost. Do not crash.
- Display `CaptureDevice.inputName` next to the level pill (EN/ES label + the OS device name, which stays in the language macOS reports). Subscribe via `CaptureService.subscribeDevice` so a Sound-settings change or a reconnect updates the name without Start/Stop.
- Log enough to debug (old device → new device, success/fail). Level bars from Step 4 should go still if the mic is gone, and move again if a new mic appears and has signal.

**Do not:** Treat a later **Start** as a special case (Start already uses the current default). Do not add BlackHole. Do not start Postgres (Step 7).

**Done when:** The window shows the current input name during preview; switching default input (or unplugging AirPods) updates the name and capture continues on the new device (or stays silent with a warning if none); README notes the reconnect + device-name test.

---

### Step 7 — Backend product foundation + schema

**Do:** PostgreSQL. Tables: `plans` (seed free + paid + Stripe price id columns), `organizations`, `users`, `usage_windows`, `workspaces`, `notes`. Keep `/health`. Move transcribe behind an internal service used by jobs (same OpenAI call as the spike). **Remove or disable `/spike/transcribe` in non-dev** (or keep it only when `CAPTURE_SPIKE_KEY` is set and `NODE_ENV=development`).

**Env (add):** `DATABASE_URL`, later Google/Stripe secrets.

**Do not:** Org product features. Do not hard-code $7.99.

**Done when:** `/health` ok; seed plans in Postgres; curl cannot transcribe in production without the spike key.

---

### Step 8 — Public website (logged-out)

**Do:** Add `website/`. Landing, download placeholder, Sign in with Google, Sign out, pricing copy (monthly vs yearly). **UI in English and Spanish:** locale files (`en`, `es`), default from the browser, **language toggle** (persisted in localStorage). No notepad. No capture.

**Done when:** Website is usable in a browser without the Mac app, in both English and Spanish.

---

### Step 9 — Google login (default free)

**Do:** OAuth on **website and Electron**. Upsert user `plan_code = free`. Sign-out works on each. Same Google account (email / subject) → one `users` row.

**Electron (locked):** Open the **system browser** (no webview, no custom URL scheme). Use **Google OAuth 2.0 PKCE** with a **Desktop** OAuth client. Google redirects to `http://127.0.0.1:<port>/callback` (loopback). Electron receives the code, sends `code` + `code_verifier` to the backend, and the backend exchanges them with Google and returns a **JWT**. Store the JWT in Electron `safeStorage` (Keychain), not `localStorage`. API calls use `Authorization: Bearer`.

**Website (later in this step):** Separate **Web** OAuth client. Google redirects to `WEBSITE_URL` (https). Session is an **httpOnly cookie**. Do not reuse the Desktop client on the website.

**Do not:** Gmail APIs. Embedded browser / Electron webview for Google. `myapp://` or other deep-link schemes for this MVP. Do not require Stripe to enter the app.

**Done when:** One Gmail account signs in on website and Electron → one user row. Electron never embeds Google.

---

### Step 10 — Stripe Checkout + quota API

**Do:** Billing module. `GET` plan + remaining quota. Website: monthly vs yearly Checkout in the **browser**. Webhook sets paid. Electron Upgrade opens the website. Spike key is not used for end users.

**Do not:** Checkout in an Electron webview. Do not hard-code caps except as `plans` seed.

**Done when:** Test-mode Checkout flips `paid`; remaining time shows; SQL change to `plans` changes caps.

---

### Step 11 — Electron shell + workspaces + notes list

**Do:** Signed-in chrome: Home, remaining time, workspace list, add workspace, notes list/detail/move/delete (confirm; block delete if `processing`). Delete workspace only if empty and not the last one. Optional title. **Wire New note to the capture module from Step 3** (debug window is not the main UI). Failed notes: Retry when allowed. UI strings **English and Spanish** (same i18n approach as the website).

**Do not:** Nested folders, sharing. Do not regress headphone capture.

**Done when:** User can add workspaces, see notes, and start a listen from the real shell using the proven capture module.

---

### Step 12 — Product listening rules + GPT bullets

**Do:** One listen at a time; Pause/Resume/Stop; **20 min pause auto-cancel**; 30 s minimum (Resume or Cancel if early); quotas; offline: keep buffering, on Stop retry upload **10 minutes** then discard; quit discards unsent audio. Valid Stop → `POST /notes/:id/stop` with 16 kHz mono 16-bit WAV (chunk at 10 min); `processing`; keep WAV until STT succeeds then delete; save transcript; GPT bullets; Retry per `error_code`. Jobs survive Home. Permission fallback warning stays.

**Do not:** Store wav overnight or after STT. Live captions. Speaker names. Stripe inside this job.

**Done when:** ≥30 s headphone meeting → bullets for **both** sides (when system audio allowed); EN/ES match the meeting; pause 20 min discards; failed GPT can Retry without re-recording.

---

### Step 13 — macOS installer + website download

**Do:** electron-builder mac artifact with entitlements for mic + audio tap. Website download link. Document both permission prompts.

**Done when:** Install from the website, grant permissions, headphone Meet/Zoom still works, test Checkout works.

---

### Step 14 — Harden and document

**Do:** Gitignore audit. README: capture verification, curl examples, three projects, env, Google, Stripe, OpenAI, permissions, entitlements, `plans` SQL, Windows future. Failed notes visible. No spike key in production.

**Done when:** A new developer can follow README only.

## Out of scope for this MVP

- **Screen / video recording** — no frames, no screenshots, even if macOS labels the permission “Screen Recording”
- **Virtual audio drivers** — no BlackHole, Loopback, VB-Cable, or a user-installed virtual mixer (the Japanese “virtual mic” diagram is *not* the shipping architecture)
- Meeting bots that join the call; Gmail / Calendar data
- Live captions / real-time transcript UI; speaker names / diarization
- Shipping Windows `.exe` or Linux (Windows system-audio is a later native module)
- Nested folders
- Organization / team product (schema stub only)
- Shared workspaces, rich text, mobile
- Admin UI for `plans`
- Stripe Checkout inside Electron
- Other currencies (USD only); other meeting languages (English and Spanish only)
- Redis unless a later job step cannot wait on Postgres jobs

## Decisions (locked)

| Topic | Decision |
| --- | --- |
| Unpaid users | App + site on **free** caps; not blocked |
| Stripe | Real Checkout; **$7.99/mo** and **$87.99/yr**; **USD always** |
| Where to pay | **Website / system browser**; Electron Upgrade opens the browser |
| After Checkout | Website success/account page; user closes the Checkout tab |
| Minimum listen | **30 seconds** |
| Early stop | **Resume** or **Cancel** (confirm, discard) |
| Electron auth | System browser, **PKCE**, **loopback** `127.0.0.1`; backend issues **JWT** (`safeStorage`). No webview, no custom scheme. Website uses a separate Web OAuth client + cookie. |
| Title | User-typed; else **first bullet** |
| Build order | **Capture first** (Steps 1–5). Live levels (4) and tap reconnect (6) stay in the spike. Product (auth, Stripe, notes) only after headphone transcript passes (Step 5); website is Step 8 |
| Capture | **AVAudioEngine** (mic) + **ScreenCaptureKit** (system audio, no video); mix **16-bit PCM WAV, mono, 16 kHz**; product upload **chunks at 10 min**; no CATap, no driver |
| Pause | **Auto-cancel after 20 minutes** paused (discard); warn at 1 minute left |
| Offline / upload | Keep buffering while listening; retry upload **10 minutes** on Stop; then warn and discard. Quit discards unsent audio |
| Retry failed note | `POST /notes/:id/retry`: STT if WAV still in job temp; GPT if `transcript_text` exists; else record again |
| Delete workspace | Only if **empty**; never delete the **last** workspace |
| STT + LLM | **OpenAI GPT** only; one mixed blob |
| Workspaces | **Multiple per user**, no nesting |
| Free quota | 60 min / 10 notes per **30 days from signup**; 30 min per note |
| Paid quota | **100 hours / month** even on yearly; unlimited notes; **no** per-note cap |
| Paid window | Stripe cycle if monthly; **monthly 100-hour reset** if yearly |
| Languages | **English and Spanish**; bullets = language of the meeting; mixed EN+ES → **dominant** language |
| UI language | **Website and Electron chrome: English and Spanish** (toggle + browser default). Meeting **summaries** still follow the meeting language, not the UI language. |
| Spike transcribe | **Dev-only** (`CAPTURE_SPIKE_KEY`). Never on a public server |
| Limits source | **`plans` table** for quotas; **env + `GET /config`** for pause/upload/chunk/min-listen. **No magic numbers in UI or handlers.** |
| Remaining time | Website account, Electron home, during session |
| Org | FK + table only |
| Windows | Builder prepared, not shipped |

## Still open

None. Mixed-language meetings, EN/ES UI, and the spike key are locked in **Decisions** above. After Step 7 is confirmed, next code step is **Step 8** (public website).
