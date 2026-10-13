-- vitrine on Cloudflare Workers: everything the Go server keeps in
-- vitrine.json, as D1 tables. File bytes live in R2.

-- Server secrets generated on first use (the HMAC signing key).
CREATE TABLE kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
  note TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,            -- ISO 8601, UTC
  updated_at TEXT NOT NULL,
  latest INTEGER NOT NULL,             -- newest committed version
  next_n INTEGER NOT NULL              -- highest reserved version number
);
CREATE INDEX artifacts_order ON artifacts (pinned DESC, updated_at DESC);

-- files is a JSON array of {name, size, type, src?}; src is the version whose
-- R2 objects hold the bytes when a file was kept or restored from an earlier
-- version (artifacts/<id>/v<src>/<name>), so nothing is ever copied.
CREATE TABLE versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  entry TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, n)
);

CREATE TABLE shares (
  token TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  max_views INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  password_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX shares_artifact ON shares (artifact_id);

-- Keyed hashes (never raw addresses) of visitors counted against max_views.
CREATE TABLE share_visitors (
  token TEXT NOT NULL REFERENCES shares (token) ON DELETE CASCADE,
  visitor TEXT NOT NULL,
  PRIMARY KEY (token, visitor)
);

-- Unlimited links count a visitor once per hour; key is a keyed hash.
CREATE TABLE share_recent (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,           -- hex SHA-256 of the vt_ secret
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                 -- base64url credential id
  name TEXT NOT NULL,
  x TEXT NOT NULL,                     -- base64url P-256 coordinates
  y TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,               -- hex SHA-256 of the cookie value
  expires INTEGER NOT NULL             -- unix ms
);

CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- Rate limiting: failed sign-ins per address, the global cap, passkey begins.
CREATE TABLE failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first INTEGER NOT NULL,
  lock INTEGER NOT NULL DEFAULT 0
);
