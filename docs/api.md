# API

Authenticate with `Authorization: Bearer vt_...` (an API token from Settings or `vitrine token`).
Browser sessions also work, but cookie-authenticated writes must send `X-Vitrine: 1`.
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
| `GET` | `/api/artifacts/{id}/download/{file}?v=N` | — | file as attachment |
| `POST` | `/api/artifacts/{id}/shares` | `{ttl: "1h"\|"24h"\|"7d"\|"30d", note?, version?}` | `201` share, pinned to `version` (default: the current latest) |
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
the first top-level `.html`, `.md`, `.pdf`, `.svg` or image. Without a `title`, Vitrine uses
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
| `GET /s/{token}` | share page (`410` when expired or revoked) |
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
| `delete_artifact` | delete; only when the user asks |

## Misc

| Path | |
|---|---|
| `GET /health` | `{ok, version}` |
| `GET /design.md`, `GET /template.html` | theme design guide for agents |
| `GET /api/me` | session state |
