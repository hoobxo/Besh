-- Besh schema. Applied once with `wrangler d1 migrations apply besh --remote`.

-- from 0001_init.sql
-- Besh schema, version 1.
--
-- One administrator, their server inventory, custom groups and the host keys the
-- administrator has accepted. Credentials live only as sealed envelopes; nothing
-- in this schema can be read back as a plaintext secret.

PRAGMA foreign_keys = ON;

-- Exactly one row. The CHECK makes "single administrator" a database rule rather
-- than a convention that a bug could quietly break.
CREATE TABLE admin (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Session tokens are stored hashed: a database leak must not hand out live
-- sessions.
CREATE TABLE admin_sessions (
  token_hash TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE server_groups (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Group names are compared case-insensitively so "生产" and "生产 " cannot become
-- two groups by accident.
CREATE UNIQUE INDEX server_groups_name_unique ON server_groups (lower(trim(name)));

CREATE TABLE servers (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  host           TEXT    NOT NULL,
  port           INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username       TEXT    NOT NULL,
  auth_method    TEXT    NOT NULL CHECK (auth_method IN ('password', 'publickey')),
  group_id       TEXT    REFERENCES server_groups (id) ON DELETE SET NULL,
  -- Sealed envelope JSON: { v, keyVersion, iv, data }. Never plaintext.
  credential     TEXT    NOT NULL,
  -- Host key the administrator accepted, plus when they accepted it.
  fingerprint    TEXT,
  trusted_at     INTEGER,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX servers_group_idx ON servers (group_id);

-- from 0002_settings.sql
-- Simple key/value settings.
--
-- Deliberately not per-user: Besh has exactly one administrator, so a setting is
-- a property of the installation. The AI permission lives here rather than in
-- localStorage because the server must be able to read it when deciding whether a
-- proposed command may run.

CREATE TABLE settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO settings (key, value, updated_at) VALUES ('ai_permission', 'confirm', 0);

-- from 0003_ai_messages.sql
-- Assistant conversation history.
--
-- Keyed by server rather than by session: a session is disposable (it holds one
-- SSH connection), while the conversation about a host is worth keeping across
-- reconnects. Entries are stored as the same JSON the client renders, so the shape
-- lives in one place.

CREATE TABLE ai_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  TEXT    NOT NULL,
  entry      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX ai_messages_server ON ai_messages (server_id, id);

-- from 0004_ai_conversations.sql
-- Several conversations per server.
--
-- The assistant used to keep one thread per host, which made the design's
-- conversation list impossible. Each row now names the conversation it belongs to;
-- existing rows fall into a default one so nothing is lost.

ALTER TABLE ai_messages ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'default';

CREATE INDEX ai_messages_conversation ON ai_messages (server_id, conversation_id, id);

-- from 0005_ai_conversation_titles.sql
-- A conversation can be renamed.
--
-- The list derives its title from the first thing the user asked, which is a good
-- default but not always what the thread turns out to be about. A row here overrides
-- that default; an absent row means "use the first question".

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX ai_conversations_server ON ai_conversations (server_id);

-- from 0006_server_os.sql
-- The operating system a server reported.
--
-- There is no way to know it before connecting: the name comes from
-- /etc/os-release during a session. The session object writes it once, and the
-- sidebar uses it to show the right mark. NULL means "never seen".

ALTER TABLE servers ADD COLUMN os TEXT;

-- from 0007_ai_usage.sql
-- Token accounting for the assistant.
--
-- One row per conversation per day: enough to show what a conversation has cost
-- and to enforce a daily ceiling without scanning every message row. The counters
-- are cumulative and updated in place, so the write path stays a single upsert.
--
-- `day` is the UTC date (`YYYY-MM-DD`). A daily budget that resets on UTC midnight
-- is predictable; local-midnight resets would need the browser's time zone in the
-- worker at write time, which is not worth it for a visibility feature.

CREATE TABLE ai_usage (
  server_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  day TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, conversation_id, day)
);

CREATE INDEX ai_usage_day ON ai_usage (day);
