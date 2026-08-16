-- Void Sheets schema (SQLite).
-- Conventions (same as the rest of VoidSuite): ids are random hex/base62
-- strings, timestamps are epoch milliseconds, positions are integers.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- VoidAuth subject id
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  picture     TEXT,
  last_seen_at INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- random session id (httpOnly cookie)
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,             -- VoidAuth tokens, server-side only
  refresh_token TEXT NOT NULL DEFAULT '',
  expires_at    INTEGER NOT NULL,
  keep_me_logged_in INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- In-flight OAuth login attempts (PKCE verifiers). Persisted instead of kept
-- in memory so a gateway restart mid-login doesn't invalidate the flow.
CREATE TABLE IF NOT EXISTS pkce_states (
  state      TEXT PRIMARY KEY,             -- the OAuth state bound to the browser cookie
  verifier   TEXT NOT NULL,                -- PKCE code_verifier (consumed once)
  expires_at INTEGER NOT NULL,             -- epoch ms
  created_at INTEGER NOT NULL
);

-- Workbooks: the flat "My sheets" file list.
CREATE TABLE IF NOT EXISTS workbooks (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  vault      INTEGER NOT NULL DEFAULT 0,   -- 1 = E2E encrypted, server stores ciphertext only
  position   INTEGER NOT NULL DEFAULT 0,   -- ordering on the home page
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-file sharing (viewer | editor). The owner is implicit in workbooks.owner_id.
CREATE TABLE IF NOT EXISTS workbook_members (
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'viewer',  -- viewer | editor
  added_by    TEXT NOT NULL REFERENCES users(id),
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (workbook_id, user_id)
);

-- Secret share links. Anyone with /join/<token> becomes a member with the
-- link's role. Tokens are high-entropy randoms (24+ bytes).
CREATE TABLE IF NOT EXISTS share_links (
  token       TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'editor',  -- viewer | editor
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

-- Server-authoritative document state for synced (non-vaulted) workbooks.
-- `document` is the full Univer snapshot JSON; `version` is an incrementing
-- revision used for optimistic-concurrency checks.
CREATE TABLE IF NOT EXISTS workbook_docs (
  workbook_id TEXT PRIMARY KEY REFERENCES workbooks(id) ON DELETE CASCADE,
  document    TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Append-only op log (synced workbooks). `seq` is monotonic per workbook and
-- is the ordering key for replay + LWW conflict resolution. Kept bounded:
-- old ops are pruned into checkpoints (see versions.kind='checkpoint').
CREATE TABLE IF NOT EXISTS ops (
  id          TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  op          TEXT NOT NULL,               -- JSON op {cmd, sheetId, params}
  actor_id    TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (workbook_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_ops_workbook_seq ON ops(workbook_id, seq);

-- Version history: automatic checkpoints (debounced snapshots) + named
-- versions. Vaulted workbooks never write snapshots here — their history
-- lives client-side as encrypted blobs.
CREATE TABLE IF NOT EXISTS versions (
  id          TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,               -- checkpoint | named
  name        TEXT,                        -- only for named versions
  snapshot    TEXT NOT NULL,               -- Univer snapshot JSON
  author_id   TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versions_workbook ON versions(workbook_id, created_at);

-- Vaulted workbooks: single encrypted blob (AES-GCM ciphertext). The server
-- never sees plaintext document content; only this and the workbook name.
CREATE TABLE IF NOT EXISTS vault_blobs (
  workbook_id TEXT PRIMARY KEY REFERENCES workbooks(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,               -- base64(iv||ciphertext)
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Vault-key escrow fallback: when the client can't reach VoidAuth storage
-- (e.g. browser-mode login without a session), the client-wrapped vault key
-- is parked here. The value is AES-GCM ciphertext wrapped with the user's
-- device key — the gateway can store it but never read the vault content.
CREATE TABLE IF NOT EXISTS vault_escrow (
  key         TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);