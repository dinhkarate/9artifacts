# Install 9artifacts — instructions for AI agents

You are helping a user install **9artifacts**, a self-hosted gallery where AI agents publish
HTML, Markdown, SVG, images and PDFs, and the owner reviews them behind a passkey.
Source: https://github.com/dinhkarate/9artifacts (MIT).

Follow these steps in order. Stop and ask the user whenever something below says *ask*.

## Rules

- Never print, log or paste an API token into the chat. Pipe it straight into the place that
  stores it (an agent config or a secret manager).
- Only touch the server the user named. Show the commands before running anything with `sudo`.
- The first-run setup (password and passkey) is the **user's** job: give them the link, do not
  open it or fill it in yourself.
- Never create public share links unless the user asks for one.

## 1. Ask the user

1. **Where should it run?**
   - **A Linux VPS** they can reach over SSH (systemd, ports 80/443 free) → section 2A.
   - **A VPS that already runs nginx, Caddy or another proxy on 80/443** → section 2B.
   - **Docker** on any machine → section 2C.
   - **No server**: Cloudflare Workers free plan → section 2D.
2. **Two hostnames** (not needed for 2D): one for the app and one for artifact content, for
   example `art.example.com` and `art-content.example.com`. The second one isolates artifact
   JavaScript from the app, which is how claude.ai does it.
3. **An email** for Let's Encrypt (2A only).

Before installing, check that both hostnames resolve to the server:

```bash
dig +short art.example.com art-content.example.com    # both must print the server's IP
```

If they don't, tell the user which A records to create and wait.

## 2A. VPS, automatic HTTPS

```bash
ssh HOST 'curl -fsSL https://raw.githubusercontent.com/dinhkarate/9artifacts/main/install.sh \
  | sudo sh -s -- --domain art.example.com --content-domain art-content.example.com --email you@example.com'
```

This installs the binary to `/usr/local/bin/9artifacts`, a hardened `9artifacts.service`, and
gets certificates itself. The output ends with a **first-run link**. Go to step 3.

## 2B. VPS behind your own reverse proxy

```bash
ssh HOST 'curl -fsSL https://raw.githubusercontent.com/dinhkarate/9artifacts/main/install.sh \
  | sudo sh -s -- --url https://art.example.com --content-url https://art-content.example.com'
```

9artifacts then listens on `127.0.0.1:8080`. Proxy both hostnames to it, passing `Host`,
`X-Forwarded-For` and `X-Forwarded-Proto`, with buffering off and a long read timeout (it
streams uploads and live reload). Do not add `X-Frame-Options` (it breaks the content iframe).
Ready-made configs: https://github.com/dinhkarate/9artifacts/blob/main/deploy/nginx.conf and
https://github.com/dinhkarate/9artifacts/blob/main/deploy/Caddyfile. Then go to step 3.

## 2C. Docker

```bash
docker run -d --name 9artifacts --restart unless-stopped -p 8080:8080 -v 9artifacts:/data \
  -e NINEARTIFACTS_URL=https://art.example.com \
  -e NINEARTIFACTS_CONTENT_URL=https://art-content.example.com \
  -e NINEARTIFACTS_TRUST_PROXY=1 \
  ghcr.io/dinhkarate/9artifacts
docker logs 9artifacts 2>&1 | grep "first run"
```

Put a TLS proxy in front as in 2B (for a local try-out, `NINEARTIFACTS_URL=http://localhost:8080`
and no content URL is fine). In step 5 use `docker exec 9artifacts /9artifacts token --name NAME`.

## 2D. Cloudflare Workers (no server)

Send the user to
https://deploy.workers.cloudflare.com/?url=https://github.com/dinhkarate/9artifacts/tree/main/cloudflare
and tell them to set the `SETUP_TOKEN` secret to a random string of 16+ characters when asked.
If you have `wrangler` and the user is logged in, you can do it yourself instead:

```bash
git clone https://github.com/dinhkarate/9artifacts && cd 9artifacts/cloudflare
npm ci
npx wrangler r2 bucket create 9artifacts-files
openssl rand -base64 32 | npx wrangler secret put SETUP_TOKEN   # the user needs this value: store it in their password manager, not the chat
npm run deploy
```

The app is at `https://9artifacts.<subdomain>.workers.dev`. There is no server shell, so in
step 5 the user creates the token in **Settings → Connect an AI agent** and gives it to you
through their secret store or environment.

## 3. Check that it runs

```bash
curl -fsS https://art.example.com/health          # {"ok":true,"version":"..."}
```

If it fails: `ssh HOST 'sudo journalctl -u 9artifacts -n 50 --no-pager'`.

## 4. Hand over to the user

Give the user the first-run link from the install output (if it scrolled away:
`ssh HOST 'sudo journalctl -u 9artifacts --no-pager -o cat | grep "first run"'`). Ask them to
open it, set the owner password and add a passkey in Settings. **Wait until they confirm.**

## 5. Connect yourself

Create a token on the server and pipe it straight into your own configuration. Pick the block
for the agent you are. `HOST` is the SSH host, `NAME` a label such as `claude-code-laptop`.

**Claude Code**

```bash
claude mcp add --transport http 9artifacts https://art.example.com/mcp \
  --header "Authorization: Bearer $(ssh HOST 'sudo 9artifacts token --data /var/lib/9artifacts --name NAME')"
```

**Codex** — keep the token in an environment variable the user's shell exports (or their secret
manager), then:

```bash
codex mcp add 9artifacts --url https://art.example.com/mcp --bearer-token-env-var NINEARTIFACTS_TOKEN
```

**Cursor** — add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{ "mcpServers": { "9artifacts": { "url": "https://art.example.com/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

**claude.ai, ChatGPT and other apps with remote connectors** need no token: tell the user to
add a custom connector with the URL `https://art.example.com/mcp` and approve it with their
passkey.

**Any other agent with a shell** — install the skill and the CLI, and log the CLI in:

```bash
npx skills add dinhkarate/9artifacts
curl -fsSL https://raw.githubusercontent.com/dinhkarate/9artifacts/main/install.sh | sh -s -- --no-service   # without root it lands in ~/.local/bin
ssh HOST 'sudo 9artifacts token --data /var/lib/9artifacts --name NAME' | 9artifacts login https://art.example.com
```

## 6. Prove it works

Publish a small test page and give the user its private URL:

```bash
echo '<title>Hello from your agent</title><h1>9artifacts is connected</h1>' > /tmp/hello.html
9artifacts publish /tmp/hello.html          # or the publish_artifact MCP tool
```

Then tell the user what they can ask from now on:

- "Make a dashboard of this CSV and publish it to 9artifacts."
- "Update that artifact with the new numbers." (same URL, their open tab reloads)
- "Fix the comments on the Q3 report." (read with `list_comments`, publish, `resolve_comment`)
- "Share it for 7 days with a password." (only when asked)

More: the agent skill at
https://github.com/dinhkarate/9artifacts/blob/main/skills/9artifacts/SKILL.md and the REST API at
https://github.com/dinhkarate/9artifacts/blob/main/docs/api.md.
