# Besh

[中文](README.md) · English

An SSH console in the browser that runs entirely on Cloudflare Workers — no server of your own to maintain, no local database to back up. A terminal, SFTP, host metrics and an AI assistant that proposes commands for you to approve, all in one interface.

Built on Cloudflare Workers + Durable Objects + D1 + R2. The SSH protocol itself lives in `packages/ssh-core` inside this repository; it does not depend on a library such as ssh2 that needs native bindings.

The interface is React 19 + Vite + Tailwind CSS 4, with components from shadcn/ui (Radix UI), xterm.js for the terminal, CodeMirror 6 for the in-browser editor and i18next for translations. There is no separate web service: the built frontend is served by the Worker's static assets binding on the same origin, so the page, the API and the WebSocket share one hostname.

![Workspace](assets/workspace.png)

## Origin

The SSH implementation behind the terminal and SFTP was extracted from the SSH source shipped by [CF-Workers-WebSSH](https://github.com/cmliu/CF-Workers-WebSSH) (Apache-2.0): packet encoding and decoding, key exchange, encryption and authentication exchanges, and SFTP packet handling. The connection state machine, bidirectional rekey, the SFTP session layer, host fingerprint verification and all interface adaptation are this project's own work.

## Features

**Terminal**

- A full PTY/shell that reconnects automatically after a drop and keeps the output already on screen (backoff 0.5 / 1 / 2 / 4 / 8 seconds; a manual disconnect opts out)
- Rekey mid-session: a key exchange started by the server and one started by the client on a threshold (1 GiB / 1 hour by default) take the same path
- Keepalive: `keepalive@openssh.com` every 45 seconds

**SFTP**

- Breadcrumb path bar; click a parent to jump there
- The context menu lists only what applies right now: new file / new folder / rename / download / upload / copy path / delete / go up
- Text preview, and uploading several files at once
- Transfer queue: uploads and downloads run one at a time, the list shows per-file progress, and each entry can be cancelled or retried on its own; an interrupted chunk resumes from the acknowledged byte instead of starting over
- Edit text files in the browser: syntax highlighting by extension (sh / json / yaml / toml / ini / nginx / Dockerfile), Ctrl+S to save, size and mtime compared before saving so an external change can be overwritten or reloaded deliberately; anything over 512 KB or binary is refused
- Recursive delete re-runs LSTAT on every child, so a symbolic link is removed as a link and never followed into its target

**Status**

- CPU / memory / disk percentage and usage, collected as soon as a session connects and refreshed every 15 seconds
- When the core count cannot be read, only the triple is shown — no percentage is invented

**AI assistant**

- Streaming output, interruptible while it is being generated
- The model only produces command text; risk assessment and approval happen on the server: a proposal expires after 60 seconds, works once, and approval re-reads the permission and re-checks the command text
- Semi-automatic mode: read-only commands run directly, everything else still needs a human approval
- Attachments accept PNG / JPG / JPEG / WebP up to 8 MB each and are stored in R2; reopening a conversation re-attaches the most recent 4 images to the context
- Token usage is tracked per conversation and per day ("today" resets at UTC midnight) for display only
- Any OpenAI-compatible endpoint that supports function calling will work

**Security and interface**

- Single administrator: PBKDF2-SHA-256 password, session tokens stored only as digests, HttpOnly cookie; changing the password or logging out revokes established WebSockets immediately
- Credentials are sealed with AES-256-GCM before they reach D1 and are never echoed back to the interface; host fingerprints are persisted and a changed fingerprint refuses the connection
- Connection targets are validated before dialling: private networks, loopback, link-local, cloud metadata addresses, IPv6-mapped spellings and DNS rebinding are all rejected
- Optional Turnstile challenge — strongly recommended
- Three-column layout, light and dark themes, Chinese and English

## Requirements

- Node.js ≥ 22.12
- A Cloudflare account (Workers, D1, R2)

## Run locally

```bash
npm ci
npm run check:web      # build the frontend; the worker serves dist directly
npx wrangler d1 execute besh --local --file=db/migrations/0001_init.sql
npm run dev
```

Open the address the terminal prints; the first visit shows the form that creates the administrator.

`npm run check` runs the strict type check, the frontend build and a bundle dry-run in that order.

## Changing the schema

The project is still in development and does not keep incremental migration files. `db/migrations/0001_init.sql` is the complete schema; after editing it, run the affected statements against existing databases:

```bash
npx wrangler d1 execute besh --local  --command "ALTER TABLE …"   # local
npx wrangler d1 execute besh --remote --command "ALTER TABLE …"   # production
```

To start over entirely, delete the database, recreate it, and run `0001_init.sql` once more.

## Deploy to your own Cloudflare account

```bash
npm ci
npm run check:web
npx wrangler d1 create besh                     # put the returned id into wrangler.toml
npx wrangler d1 execute besh --remote --file=db/migrations/0001_init.sql -y
npx wrangler r2 bucket create besh
npx wrangler secret put CREDENTIAL_KEY          # a base64-encoded 32-byte key
npx wrangler secret put TICKET_SECRET
npx wrangler deploy
```

The first visit shows the form that creates the administrator, and that route closes on its own once the account exists. Turnstile is optional: enter a site key and secret in the settings to turn it on.

### Deploy from GitHub (Workers Builds)

After forking, Cloudflare can build straight from the repository instead of you running commands locally:

1. `npx wrangler d1 create besh`, then write the returned `database_id` into `wrangler.toml` in your fork
2. `npx wrangler r2 bucket create besh` (or create it in the Cloudflare dashboard)
3. Dashboard → Workers & Pages → Create → connect this repository, with the build and deploy commands:

   ```
   npm ci && npm run check:web && npx wrangler deploy
   ```

   Creating the tables is a one-off: run `npx wrangler d1 execute besh --remote --file=db/migrations/0001_init.sql -y`
   against the current database first, then let the build deploy.

4. After the first deployment, add `CREDENTIAL_KEY` and `TICKET_SECRET` under the Worker's Settings → Variables and Secrets (`wrangler deploy` does not overwrite secrets that already exist)

`database_id` identifies a D1 instance and cannot be someone else's; if `name`, `database_name` or `bucket_name` collide with something already in your account, rename the three places in this project that mention them.

If the build environment reports a permission error, add `CLOUDFLARE_API_TOKEN` (template: Edit Cloudflare Workers) and `CLOUDFLARE_ACCOUNT_ID` under Settings → Build → Variables and secrets. A Node version below 22.12 fails the build; add `NODE_VERSION=22` in the same place.

## Configuration

Bindings in `wrangler.toml`:

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 | Account, servers, groups, settings, conversations and usage |
| `ATTACHMENTS` | R2 | Raw bytes of AI attachments; D1 stores only the id, filename and MIME type |
| `SESSIONS` | Durable Object | One instance per SSH session, holding the PTY and the WebSocket bridge |
| `ASSETS` | Static assets | The built frontend, on the same origin as the API |

Secrets to set:

| Variable | Purpose |
| --- | --- |
| `CREDENTIAL_KEY` | Base64 of a 32-byte AES-256 key. Once rotated, every stored server credential becomes undecryptable — either re-enter them or restore the old key |
| `TICKET_SECRET` | Signing key for session tickets |

`[triggers]` contains a cron job at 04:17 UTC every day that removes attachments no conversation points at; it only touches objects older than 24 hours, so an upload in flight is never affected.

## Project layout

```text
apps/worker/          Cloudflare platform adapter: HTTP routes, Durable Object, sockets
apps/web/             Vite + React + shadcn/ui interface, served by the worker's assets binding
packages/contracts/   Public protocol and error codes, shared by the worker and the frontend
packages/ssh-core/    The SSH protocol itself: transport, key exchange, auth, channels, SFTP v3
db/migrations/        D1 schema
assets/               README screenshots
```

`ssh-core` references no platform APIs (browser, Node, `cloudflare:sockets`): the connection state machine, handshake, channels and SFTP all run outside a Worker.

## Changelog

What changed in each release, and why, is in [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
