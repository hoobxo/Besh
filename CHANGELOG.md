# Changelog

Changes worth telling users about, newest first. The repository ships the
implementation itself; this file exists so the notes for a release can be copied
out without reconstructing them from commit messages.

## v1.0.2 — unreleased

### Fixed

- **Switching tabs cleared an unsent AI message.** The assistant panel only
  existed for the selected tab, so leaving a tab threw the composer draft away.
  Every open tab now keeps its own panel mounted (hidden while it is not the
  selected one), so drafts, scroll position and a reply that is still streaming
  survive a switch. (pps/web/src/views/terminal-view.tsx)

- **Long unbroken text spilled out of dialogs.** File names, paths and host key
  fingerprints are single tokens with no break opportunity, so they painted over
  the card's edge — the delete confirm, the new host key prompt and any dialog
  carrying a long path. Dialog copy now breaks mid-token, and the host key
  prompt keeps its line breaks so the two fingerprints stay separate.
  (pps/web/src/components/ui/alert-dialog.tsx,
  pps/web/src/components/ui/dialog.tsx, pps/web/src/index.css,
  pps/web/src/components/confirm-dialog.tsx)

- **Switching tabs rewrapped the terminal.** An inactive tab is hidden, so it
  measures a fraction of its real size, and it was reporting that size to the
  server: the shell then rewrapped everything it printed at a dozen columns, so
  coming back showed a torn first line. A pane only refits and reports its size
  while it is visible. (pps/web/src/views/terminal-view.tsx)

- **A long file name broke the delete dialog.** The name sat in an unbroken
  token, which widened the dialog's single grid track: the body and the footer
  painted outside the card and the buttons ended up adrift. The track is now
  `minmax(0, 1fr)` and the title breaks anywhere, so a name of any length wraps
  inside the dialog. The plain dialog had the same track and got the same fix.
  (`apps/web/src/components/ui/alert-dialog.tsx`,
  `apps/web/src/components/ui/dialog.tsx`)

- **The terminal grid hung over the bottom of its pane.** The pane's padding was
  counted as usable height when the grid was measured, so the last row landed in
  the padding and was cut in half — most visibly at the bottom edge, right above
  the file panel. The padding now lives on a wrapper and the terminal is
  measured in an unpadded box, which leaves a small gap under the last row.
  (`apps/web/src/views/terminal-view.tsx`)

- **Long paths no longer clip in the assistant panel.** A message carrying one
  unbroken path — two absolute paths and no spaces between them, as pasted from a
  terminal — stretched the bubble past its maximum width, and the text was cut at
  both ends. The message bubble and the reply prose now break inside a token when
  they have to, so a path wraps and stays readable.
  (`apps/web/src/views/ai-panel.tsx`)

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
