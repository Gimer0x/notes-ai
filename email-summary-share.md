# Share a summary by email

Send the saved summary of one note from a Pith address. The user types recipient addresses each time. Nothing is saved as a group. Recipients reply to the signed-in user. Google sign-in stays login-only (`PLAN.md` constraint 9).

## What you need outside the repo

- A mail account (Resend, or SMTP). Verify a sending domain so messages are not dropped.
- A from address on that domain, for example `summaries@yourdomain`.
- The API key or SMTP password only in `backend/.env`. Add empty placeholders to `backend/.env.example`. Never commit the key.

## Backend

A new mail module sends the message. Notes code does not import the mail SDK, the same split used for Stripe.

- `POST /notes/:id/share` with `{ emails: string[] }`, behind the existing auth guard. Only the note’s owner can send.
- Load the note through the notes service. Send only when status is `ready` and `summary_text` is non-empty. Otherwise `409` (`not_ready` / `no_summary`).
- Validate each address, drop duplicates, and cap the list at 10. Reject an empty list with `400`.
- Subject: note title and date. Body: the summary text already stored (headings and bullets), in the meeting’s language. Plain text is enough. Set `Reply-To` to the signed-in user’s email so replies go to them, not to Pith.
- Do not attach the transcript.
- If the mail key is missing, return `503`, the same pattern as a missing OpenAI key.

## Electron

The renderer must not hold the token. Follow the existing notes path: `frontend/src/notes/notes-api.ts` → IPC in `frontend/src/main.ts` → a button on the summary in `frontend/src/renderer/shell.ts`.

- Show the control only on a ready summary, on the same line as the date (near **Move to**).
- A small dialog: one field for addresses separated by commas or new lines, **Send** and **Cancel**.
- English and Spanish strings in `frontend/src/i18n/en.json` and `frontend/src/i18n/es.json`.
- On success, a short confirmation. On failure, the existing error line.

## Docs

Update `README.md`: where the button is, that mail goes out from Pith, and which `.env` keys are required.

## Out of scope

Saved recipient groups, sending from the user’s Gmail, the transcript, the website, and billing changes.
