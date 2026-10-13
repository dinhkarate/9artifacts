---
name: vitryn
description: Publish HTML, Markdown, SVG, image or PDF artifacts to the user's self-hosted vitryn server and return a private link — like Claude artifacts, but on their own VPS. Use when the user asks to publish, upload, host, share or "make an artifact/link" of a report, dashboard, page, diagram or document, or to update or share an artifact already in vitryn.
---

# vitryn

Vitryn is the user's private artifact gallery. You publish a file, the user
opens the private URL (they sign in with a passkey), and they can share a
public link that expires.

## Setup check

Needs `VITRYN_URL` and `VITRYN_TOKEN` in the environment (or a saved
`vitryn login`). If neither is available, ask the user to create a token in
Vitryn → Settings → "Connect an AI agent". Never print the token.

Prefer the `vitryn` CLI if it is installed (`vitryn version`); otherwise use
`curl` as shown below. If the Vitryn MCP server is connected, its tools
(`publish_artifact`, `get_design_guide`, ...) do the same thing.

## 1. Match the owner's style

Before writing a new artifact, read the owner's design guide and follow it:

```bash
vitryn design            # or: curl -fsS "$VITRYN_URL/design.md"
```

Write one self-contained `index.html` (inline CSS/JS) unless the content is
plain prose, in which case write a `.md` file. Set a real `<title>` — it
becomes the artifact title.

## 2. Publish

```bash
vitryn publish report.html --tags q3,finance
vitryn publish ./site/                     # a folder: index.html + assets/
```

With curl:

```bash
curl -fsS -H "Authorization: Bearer $VITRYN_TOKEN" \
  -F files=@report.html -F tags=q3,finance "$VITRYN_URL/api/artifacts"
```

The response contains `url` (private, sign-in required) and `id`. Give the
user the private `url`. Keep the `id` for updates.

## 3. Update the same artifact

Publishing a new version keeps the URL, and the user's open tab refreshes:

```bash
vitryn publish --update ID --keep --message "fix totals" report.html
curl -fsS -H "Authorization: Bearer $VITRYN_TOKEN" -F keep=1 \
  -F files=@report.html "$VITRYN_URL/api/artifacts/ID/versions"
```

`--keep` / `keep=1` carries over files you did not resend (images, CSS).

## 4. Public links — only when asked

Create a public link only when the user explicitly asks to share publicly.
Every link expires (`1h`, `24h`, `7d`, `30d`).

```bash
vitryn share ID --ttl 7d [--max-views 5] [--password]
vitryn revoke ID SHARE_TOKEN
```

## 3. Review comments

The owner can select text in an artifact and leave comments for you. When they mention
comments or feedback ("fix the comments on X"), call `list_comments` (MCP) or
`GET /api/artifacts/ID` (`comments` with no `resolvedAt`). Fix the artifact, publish the new
version with the same id, then `resolve_comment` each one with a one-line note of what changed
(`POST /api/artifacts/ID/comments/CID/resolve {"note": "..."}`). A publish result that says
"open review comments" is a reminder to do this.

## Rules

- Default to the private URL. Never create a public link on your own.
- Do not upload secrets, credentials or `.env` files.
- Do not delete artifacts unless the user asks (`vitryn rm ID`).
- Relative paths only between files (`assets/chart.png`), no absolute `/` paths.
