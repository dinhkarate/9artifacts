# API

Authenticate with `Authorization: Bearer vt_...` (an API token from Settings or `glasshelf token`).
Browser sessions also work, but cookie-authenticated writes must send `X-Glasshelf: 1`.
Errors are JSON: `{"error": "..."}`.

## Artifacts

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/api/artifacts?q=&tag=&limit=` | — | `{artifacts: [...], tags: {tag: count}}` |
| `POST` | `/api/artifacts` | multipart or JSON (below) | `201` artifact |
| `GET` | `/api/artifacts/{id}` | — | artifact with `versions` and `shares` |
| `PATCH` | `/api/artifacts/{id}` | `{title?, tags?, note?, pinned?}` | artifact |
| `DELETE` | `/api/artifacts/{id}` | — | `{ok: true}` |
| `POST` | `/api/artifacts/{id}/versions` | multipart or JSON, plus `keep` | `201` artifact (new version) |
| `POST` | `/api/artifacts/{id}/versions/{n}/restore` | — | `201` artifact: a copy of version `n` becomes the new latest |
| `GET` | `/api/artifacts/{id}/download/{file}?v=N` | — | file as attachment |
| `POST` | `/api/artifacts/{id}/shares` | `{ttl: "1h"\|"24h"\|"7d"\|"30d", note?, version?, maxViews?, password?}` | `201` share, pinned to `version` (default: the current latest); `maxViews` stops the link after that many distinct visitors |
| `DELETE` | `/api/artifacts/{id}/shares/{token}` | — | revoke |

### Uploading

Multipart fields: `files` (repeatable), `title`, `tags` (comma-separated or repeated),
`note`, `entry`, `message`, `keep` (`1` to carry over files from the previous version).
Sub-folders are kept from the part's filename (`-F "files=@logo.png;filename=assets/logo.png"`).

```bash
curl -H "Authorization: Bearer $T" -F files=@index.html -F files=@style.css -F tags=demo $URL/api/artifacts
```

JSON, which is easier from code (up to 32 MB; use multipart for anything bigger):

```json
{
  "title": "Weekly report",
  "tags": ["team"],
  "files": [
    {"name": "index.html", "content": "<!doctype html>..."},
    {"name": "assets/chart.png", "content": "iVBORw0...", "encoding": "base64"}
  ]
}
```

The **entry** file is the one opened by default: `entry` if given, else `index.html`, else
the first top-level `.html`, `.md`, `.pdf`, `.svg` or image. Without a `title`, Glasshelf uses
the HTML `<title>` or the first Markdown `# heading`.

### Artifact object

```json
{
  "id": "k3xq...", "title": "Q3 report", "tags": ["finance"], "note": "", "pinned": false,
  "url": "https://art.example.com/a/k3xq...",
  "version": 2, "entry": "index.html", "files": [{"name": "index.html", "size": 2911, "type": "text/html; charset=utf-8"}],
  "viewBase": "https://art-content.example.com/c/<view-token>/",
  "versions": [...], "shares": [...], "activeShares": 1,
  "createdAt": "...", "updatedAt": "..."
}
```

`viewBase` + file name is a direct, sandboxed URL valid for about 12 hours.

## Public links

| Path | |
|---|---|
| `GET /s/{token}` | share page (`410` when expired, revoked or out of views) |

Shares report `views` (distinct visitors, counted once per address per hour), `maxViews` and `lastViewedAt`.
With a `password`, `/s/{token}` shows a password form (nothing about the artifact, not even its
title, is shown before) and files are served only through a short-lived signed URL issued after
unlocking (`/s/{token}/g/{grant}/{file}`); wrong guesses are rate-limited per address like logins.
| `GET /s/{token}/f/{file}` | raw file (on the content origin); `?view=1` renders Markdown, `?download=1` downloads |

## MCP

`POST /mcp` speaks the Model Context Protocol (streamable HTTP, JSON responses) with the same
bearer token.

| Tool | Purpose |
|---|---|
| `get_design_guide` | the owner's `design.md` and `template.html` |
| `publish_artifact` | create, or with `id` add a version (keeps unchanged files unless `replace_all_files`) |
| `list_artifacts` | search and list |
| `read_artifact` | read a text file of an artifact, to edit and republish |
| `share_artifact` | expiring public link; only when the user asks |
| `revoke_share` | revoke a link |
| `restore_version` | publish an earlier version again as the latest |
| `list_comments` | the owner's review comments (open ones by default) |
| `resolve_comment` | mark a comment done, with a note on what changed |
| `delete_artifact` | delete; only when the user asks |

## Remote MCP with OAuth (claude.ai, ChatGPT connectors)

Clients that support MCP authorization need no token. Add a custom connector with the URL
`https://art.example.com/mcp`; the client discovers the rest:

| Path | |
|---|---|
| `POST /mcp` without a token | `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"` |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 server metadata |
| `POST /oauth/register` | RFC 7591 dynamic registration (public clients; redirect URIs must be https, or http on localhost) |
| `GET /oauth/authorize` | consent page: the owner signs in (passkey or password) and allows or cancels |
| `POST /oauth/token` | `authorization_code` with PKCE S256 (required), or `refresh_token` |

Access tokens last 1 hour; refresh tokens last 90 days and rotate on every use (a reused
refresh token is rejected). Each connector appears in Settings → tokens as "<name> (OAuth)"
and can be revoked there. CORS is open on these endpoints and `/mcp` for browser-based clients;
no cookies are involved.

## Comments

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/api/artifacts/{id}/comments` | `{body, quote?, version?, file?}` | `201` comment on that version (default latest) |
| `POST` | `/api/artifacts/{id}/comments/{cid}/resolve` | `{note?}` | resolved comment |
| `DELETE` | `/api/artifacts/{id}/comments/{cid}` | — | `{ok: true}` |

`GET /api/artifacts/{id}` includes `comments` and `openComments`. The author is `owner` for the
browser and `agent: <token name>` for API tokens. In the viewer, selecting text inside an HTML or
Markdown artifact quotes it in the comment box: the owner's viewer (and only it, never share
links or downloads) adds a small script that reports the selection to the page.

## Webhooks

With `--webhook URL` the server POSTs a JSON event for `artifact.published`, `artifact.version`,
`share.created` and `share.visited` (a new visitor opened a share link):

```json
{"event": "share.visited", "text": "Public link opened: \"Q3 report\" v2 (visitor 1)\nhttps://art.example.com/a/k3xq...",
 "content": "…same as text…", "artifact": {"id": "k3xq...", "title": "Q3 report", "url": "https://art.example.com/a/k3xq...", "version": 2},
 "at": "2026-10-13T08:00:00Z"}
```

`text` and `content` make Slack and Discord incoming webhooks work unchanged. With an
`ntfy+https://ntfy.sh/topic` URL the message is sent as plain text with `Title` and `Click`
headers. Share tokens are never sent. Delivery is best-effort (10 s timeout, no retries);
failures are logged with the webhook host only.

## Misc

| Path | |
|---|---|
| `GET /health` | `{ok, version}` |
| `GET /design.md`, `GET /template.html` | theme design guide for agents |
| `GET /api/me` | session state |
