# Share a summary by email

Send the saved summary of one note from a Pith address. The user types recipient addresses each time. Nothing is saved as a group. Recipients reply to the signed-in user. Google sign-in stays login-only (`PLAN.md` constraint 9).

## What you need outside the repo

For a first test, use one company Gmail:

1. Create the Gmail (or a Google Workspace mailbox).
2. Turn on 2-Step Verification.
3. Create an **App Password** (Google Account → Security → App passwords). The normal sign-in password will not work.
4. Put these only in `backend/.env` (empty placeholders are in `backend/.env.example`):

```
MAIL_FROM=your.company@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your.company@gmail.com
SMTP_PASS=the-16-character-app-password
```

Later, point the same keys at a company domain (`info@pith.ai` or Resend). That is an env change, not a code change. A verified domain lands in inboxes more reliably than consumer Gmail.

## Backend

Independent mail module (`backend/src/mail/`). Notes and capture code do not import the mail SDK.

- `POST /notes/:id/share` with `{ emails: string[] }`, behind the existing auth guard. Only the note’s owner can send.
- Send only when status is `ready` and the summary is non-empty. Otherwise `409` (`not_ready` / `no_summary`).
- Validate each address, drop duplicates, and cap the list at 10. Reject an empty list with `400`.
- Subject: `Notes for "Title" - Date`. Body: HTML + plain text. First line `Meeting notes`, then `Title Date` (no quotes). Brand colors (`#2537d5` / `#7e89e6` / `#2a2e3c`), section headings, indented bullets and numbered steps. Set `Reply-To` to the signed-in user’s email.
- Do not attach the transcript.
- If the mail env keys are missing, return `503` (`mail_not_configured`).

## Electron

A small send icon sits next to **Copy** on a ready summary (after Generate, and when opening an older note).

- Dialog: one field for addresses separated by commas or new lines, **Send** and **Cancel**.
- English and Spanish strings in the frontend i18n files.
- The renderer never sees the JWT or `SMTP_PASS`.

## Out of scope

Saved recipient groups, sending from the user’s Gmail, the transcript, the website, and billing changes.
