# Changelog

Changes worth telling users about, newest first. The repository ships the
implementation itself; this file exists so the notes for a release can be copied
out without reconstructing them from commit messages.

## v1.0.1 — 2026-10-29

### Fixed

- **An SFTP upload could commit a corrupted file.** Cancelling a partly uploaded
  file deleted its staging file but kept the acknowledged byte offset. Retrying
  opened a fresh, empty staging file and wrote only the tail, so SFTP padded the
  gap with zero bytes and the row still reported success — a silently damaged
  remote file. The offset now resets with the staging file, and whenever a
  replacement upload session is opened. A chunk that fails mid-flight still
  resumes, because that path keeps its staging file.
  (`apps/web/src/lib/transfer-queue.ts`)
- **Two edits of the same server silently overwrote each other.** The version
  guard read the row and then wrote without matching the version it read, so two
  edits that both saw version N both succeeded and the later one won. The write
  now carries that version in its `WHERE` clause, a stale edit gets the existing
  409, and a row deleted in the meantime is reported as 404 instead.
  (`apps/worker/src/domain/server-store.ts`)
- **Switching the authentication method left a credential nothing could open.**
  The stored envelope is bound to the credential kind through its AAD, but the
  update kept the old envelope while rewriting the method, so the next connection
  failed with “Credential could not be opened”. The store now refuses the switch
  without a replacement credential, the form makes the field required, and the
  API answers 400.
- Reported in #1, #2 and #3; reproduced against this tree and fixed in `55e70eb`.
- **A command that printed a lot took over the chat.** Tool output was rendered
  at full length, so one `cat` of a config file pushed the conversation off the
  screen. Anything past 12 lines or 800 characters now folds to 168px behind a
  fade and an “expand N lines” control; opening it scrolls inside a 420px box
  instead of growing without bound, so the control that closes it stays in view.
  (`apps/web/src/views/ai-panel.tsx`)

### Changed

- `wrangler.toml` points at the rebuilt D1 database and no longer publishes
  `workers.dev` preview URLs (`65831dc`).
- `README.en.md` mirrors `README.md`, and each page links to the other
  (`3d8cd81`).
- The expand/collapse control on a long reply is now a bordered pill with a
  chevron that flips, shared by prose and tool output, instead of bare text that
  read as a label (`2ed131d`).
- Each server group in the settings dialog reads as three aligned columns — name,
  a count badge, then its actions — instead of a name with “N servers” underneath
  (`2ed131d`, count centred in `41b2467`).
- The model endpoint and API key are stored as soon as the field is left, so
  closing the dialog no longer loses an edit; the explicit save now sits inside
  “高级参数” and covers only what that panel holds (`eb04489`).
- The model service block no longer explains itself: the standing hint, the
  “saving…/saved” line and the note beside the save button are gone, and a failed
  autosave is reported only when it fails (`d9a8224`, `3833a13`).

## v1.0.0 — 2026-10-26

First tagged release: SSH console with PTY, SFTP (upload, download, queue with
resume, drag and drop), host metrics, per-server groups, AI tool calls behind an
approval policy, attachments in R2, and Turnstile on the login page. See the
release notes on GitHub for the full description.
