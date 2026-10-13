-- Review comments (owner → agent feedback) and OAuth for MCP connectors.

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  file TEXT NOT NULL DEFAULT '',
  quote TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  author TEXT NOT NULL,                -- "owner" or "agent: <token name>"
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT NOT NULL DEFAULT ''
);
CREATE INDEX comments_artifact ON comments (artifact_id, created_at);

-- OAuth access tokens expire and rotate with a refresh token; tokens made in
-- Settings keep expires_at NULL and never expire.
ALTER TABLE tokens ADD COLUMN expires_at TEXT;
ALTER TABLE tokens ADD COLUMN client_id TEXT NOT NULL DEFAULT '';
ALTER TABLE tokens ADD COLUMN refresh_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE tokens ADD COLUMN refresh_expires_at TEXT;
CREATE INDEX tokens_refresh ON tokens (refresh_hash);
CREATE INDEX tokens_client ON tokens (client_id);

-- MCP clients that registered themselves (RFC 7591).
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,         -- JSON array
  created_at TEXT NOT NULL
);

-- Pending authorization codes, single use, 5 minutes.
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,               -- hex SHA-256 of the code
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires INTEGER NOT NULL
);
