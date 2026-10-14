<div align="center">

<img src="web/themes/default/logo.svg" width="72" alt="9artifacts logo">

# 9artifacts

**Claude-style artifacts on your own VPS.**
Your AI agents publish HTML, Markdown, diagrams and PDFs; you view them in a private, passkey-protected gallery and share expiring links when you want to.

One ~10 MB Go binary · ~10 MB RAM · no database · no Node · no Docker required

[![ci](https://github.com/dinhkarate/9artifacts/actions/workflows/ci.yml/badge.svg)](https://github.com/dinhkarate/9artifacts/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/dinhkarate/9artifacts?sort=semver)](https://github.com/dinhkarate/9artifacts/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

English · [Tiếng Việt](README.vi.md)

<img src="docs/images/demo.gif" alt="An agent publishes a dashboard to 9artifacts over MCP, publishes v2 and the open tab live-reloads, then an expiring share link is created" width="100%">

</div>

## Why

Claude, ChatGPT, Codex and Cursor are great at producing **artifacts**: dashboards, reports,
diagrams, landing-page drafts. But they end up in a chat sidebar, a `/tmp` folder, or a public
link on someone else's servers.

If you already rent a VPS, 9artifacts gives those artifacts a home you own:

- **Private by default.** Everything needs your passkey. Nothing is public until you create a
  link, and every public link **expires** (1 hour to 30 days), can be revoked, and can have a
  **password** and a **view limit**. Link previews in Slack or Discord never use up a view.
- **Made for agents.** A built-in **MCP server**, a CLI and an installable **agent skill** let
  Claude Code, Codex, Cursor or any MCP client publish and update artifacts. They get back a
  private URL to give you. claude.ai and ChatGPT connect as remote connectors over **OAuth**.
- **Review loop.** Select text in an artifact, leave a comment, tell your agent to "fix the
  comments": it reads them over MCP, publishes v2 and resolves them. Restore any old version.
- **Feels like Claude's artifact viewer.** Full-bleed sandboxed viewer, version history, and
  **live reload**: when the agent publishes v2, your open tab updates by itself.
- **Your style, everywhere.** Agents read your `design.md` before writing, so everything they
  publish matches your look. The app UI is themeable too, and your AI can restyle it for you.
- **Tiny, and free to run.** A single static binary with automatic HTTPS. It is happy on a
  1 vCPU / 512 MB box or a Raspberry Pi. No server at all? Deploy the **Cloudflare Workers
  edition** on the free plan, or run `9artifacts-ts` at home with Tailscale built in.
- **Tells you.** Webhooks to Slack, Discord or ntfy when an agent publishes or someone opens
  your link.

## Screenshots

![gallery](docs/images/gallery-light.png)

| Viewer + expiring share links | Markdown, rendered |
|---|---|
| ![viewer](docs/images/viewer-share-light.png) | ![markdown](docs/images/viewer-markdown-dark.png) |

| Connect an agent in one click | Themes: `terminal` and `paper` |
|---|---|
| ![settings](docs/images/settings-dark.png) | ![terminal theme](docs/images/theme-terminal-gallery-dark.png) |

<p align="center"><img src="docs/images/mobile-gallery.png" width="240" alt="mobile gallery"> <img src="docs/images/mobile-viewer.png" width="240" alt="mobile viewer"></p>

## Quick start

### On a VPS (automatic HTTPS)

Point two DNS records at your server: one for the app, one for artifact content (see
[Security](#security) for why). Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/dinhkarate/9artifacts/main/install.sh \
  | sudo sh -s -- --domain art.example.com --content-domain art-content.example.com --email you@example.com
```

This installs the binary and a hardened systemd service. 9artifacts fetches Let's Encrypt certificates
itself. Open the first-run link it prints, set a password, and add a passkey.

### Docker

```bash
docker run -d --name 9artifacts -p 8080:8080 -v 9artifacts:/data \
  -e NINEARTIFACTS_URL=http://localhost:8080 ghcr.io/dinhkarate/9artifacts
docker logs 9artifacts   # prints the first-run link
```

### From source

```bash
go install github.com/dinhkarate/9artifacts/cmd/9artifacts@latest
9artifacts serve --url http://localhost:8080
```

Running behind nginx, Caddy, a Cloudflare Tunnel or Tailscale? See [docs/deploy.md](docs/deploy.md).
There is also a guide to running it for **free**: on your own machine with Tailscale or a
Cloudflare Tunnel, or on a free-tier VM.

## Connect your AI agent

Create a token in **Settings → Connect an AI agent**. The page shows ready-to-paste commands,
or you can run `sudo 9artifacts token --data /var/lib/9artifacts` on the server.

**Claude Code (MCP)**

```bash
claude mcp add --transport http 9artifacts https://art.example.com/mcp \
  --header "Authorization: Bearer vt_..."
```

Then just ask: *"Make a dashboard of this CSV and publish it to 9artifacts."*

**Any agent (skill + CLI)**

```bash
npx skills add dinhkarate/9artifacts          # installs the 9artifacts skill for Claude Code, Codex, Cursor...
export NINEARTIFACTS_URL=https://art.example.com NINEARTIFACTS_TOKEN=vt_...
```

**CLI**

```bash
9artifacts publish report.html --tags q3,finance        # → https://art.example.com/a/k3x...
9artifacts publish ./site/                               # a folder: index.html + assets/
9artifacts publish --update k3x... --keep report.html    # new version, same URL, live reload
9artifacts share k3x... --ttl 7d                         # expiring public link
```

**curl**

```bash
curl -H "Authorization: Bearer $NINEARTIFACTS_TOKEN" -F files=@report.html \
  https://art.example.com/api/artifacts
```

**claude.ai, ChatGPT and other remote-connector apps:** add a custom connector with the URL
`https://art.example.com/mcp`. 9artifacts speaks MCP OAuth (discovery, dynamic registration,
PKCE), so you just approve the connection with your passkey; no token to copy.

MCP tools: `get_design_guide`, `publish_artifact`, `list_artifacts`, `read_artifact`,
`share_artifact`, `revoke_share`, `restore_version`, `list_comments`, `resolve_comment`,
`delete_artifact`. The full REST API is in
[docs/api.md](docs/api.md).

## Make it yours

```bash
9artifacts theme init ./my-theme            # theme.css, design.md, template.html, logo.svg, markdown.css
9artifacts serve --theme-dir ./my-theme ...
```

- **`theme.css`** holds every colour, font and radius of the app as CSS variables, for both
  light and dark mode. Try asking your AI: *"Restyle my-theme/theme.css like Linear."*
- **`design.md` + `template.html`** form the house style for artifacts. Agents fetch them through
  MCP (`get_design_guide`) or `9artifacts design` before writing, so a report made by Claude
  today and one made by Codex next month look like they belong together.
- Built-in themes: `default`, `terminal`, `paper` (`--theme terminal`).
- `9artifacts theme init --full` also exports the app shell (HTML/JS/CSS) for deeper changes. Keep `nonce="{{.Nonce}}"` on the `<script>` tag in `index.html`, or the CSP will block the app.

## Security

9artifacts is meant for documents you would not paste into a public pastebin. The design:

| Concern | How 9artifacts handles it |
|---|---|
| Malicious or buggy artifact JS | Every artifact response except PDFs carries `Content-Security-Policy: sandbox`, so it runs on an opaque origin with no cookies and no API access, even when opened in a new tab. Content types come from a fixed table, and unknown extensions download as `application/octet-stream`. With `--content-url`, artifacts also live on a **separate origin**, which is how Claude.ai isolates them. |
| Sub-resources in a sandbox | Short-lived HMAC **view tokens** are scoped to one artifact version, so sibling CSS and images load without exposing your session. |
| Login | **Passkeys** (WebAuthn, user verification required, signature-counter checks) or a PBKDF2 password. Lockout applies after 5 failures per address plus a global cap. Sessions use a `__Host-` cookie that is `HttpOnly`, `Secure` and `SameSite=Strict`, plus a CSRF header check. |
| Agent access | API tokens are stored only as SHA-256 hashes and can be revoked. Agents cannot mint tokens or change login settings. |
| Public links | Unguessable 144-bit tokens, **pinned to the version you shared**. Every link must expire, and revoked or expired links return `410 Gone`. |
| Logs | Share and view tokens are **redacted** from 9artifacts's request log. |
| Files | Upload paths are validated and written through `os.Root`, so traversal is impossible. Responses are served with `nosniff`. |
| App UI | Nonce-based CSP (an uploaded `.js` can never run as app code), `X-Frame-Options: DENY`, and HSTS on HTTPS. |

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## How it compares

| | 9artifacts | Claude.ai artifacts | Static hosting / S3 |
|---|---|---|---|
| Runs on your server | ✅ | ❌ | ✅ |
| Private by default | ✅ passkey | ❌ (publish = public) | ❌ |
| Expiring, revocable links | ✅ + password, view limit | ❌ | DIY |
| Review comments the agent fixes | ✅ | ✅ (Claude Code) | ❌ |
| Any agent can publish (MCP / CLI / skill) | ✅ | Claude only | DIY |
| Versions + live reload | ✅ | ✅ | ❌ |
| Sandboxed, separate content origin | ✅ | ✅ | ❌ |
| Your design system applied by agents | ✅ `design.md` | ❌ | ❌ |
| Footprint | ~10 MB binary | — | — |

## FAQ

**Can I run it for free?** Yes. Run it on any machine you own and expose it with Tailscale
(free `*.ts.net` HTTPS, no domain needed) or a Cloudflare Tunnel, or use Oracle Cloud Always
Free or a Google Cloud `e2-micro`. See [docs/deploy.md](docs/deploy.md#free-hosting).

**Is this related to 9Router?** No. The name is a friendly nod to
[9Router](https://github.com/decolua/9router), which many of us use with the same agents, but
9artifacts is an independent project with no affiliation.

**Multiple users?** Not yet. 9artifacts is single-owner by design; share with others through expiring links.

**Where is my data?** Everything lives in one directory: a `9artifacts.json` index plus your files under
`artifacts/<id>/v<n>/`. Back it up with `tar` or `restic`.

**Backups / migration?** Stop the service, copy the data directory, and start it on the new host.

## Roadmap

- [x] Review comments that go back to the agent
- [x] Remote MCP over OAuth (claude.ai, ChatGPT connectors)
- [x] Password-protected and view-limited share links
- [x] Cloudflare Workers edition and a Tailscale build
- [ ] Zip upload and folder upload from the browser
- [ ] Full-text search inside artifacts
- [ ] Optional client-side encryption for share links
- [ ] Read-only collaborators

## Contributing

Issues and PRs are welcome. Run `go test ./...` before sending a PR; see [CONTRIBUTING.md](CONTRIBUTING.md).
If 9artifacts is useful to you, a ⭐ helps other self-hosters find it.

## License

[MIT](LICENSE)
