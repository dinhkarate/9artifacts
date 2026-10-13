# Deploying Vitrine

Vitrine is a single binary that keeps all its state in one data directory.
Pick the setup that matches your server.

- [1. Standalone with automatic HTTPS](#1-standalone-with-automatic-https) (simplest)
- [2. Behind nginx, Caddy or Traefik](#2-behind-nginx-caddy-or-traefik)
- [3. Docker / Compose](#3-docker--compose)
- [4. Home server or laptop with Cloudflare Tunnel](#4-home-server-with-cloudflare-tunnel)
- [5. Home server or laptop with Tailscale](#5-home-server-with-tailscale)
- [Free hosting](#free-hosting)
- [Configuration reference](#configuration-reference)
- [Backups and upgrades](#backups-and-upgrades)

## Two domains (recommended)

Artifacts are untrusted HTML. Vitrine always sandboxes them, but serving them from a
**second origin** adds a second wall, and it is the same model Claude.ai uses. Use a sibling
name such as `art-content.example.com`, or better, a domain you use for nothing else.
With one domain everything still works; the sandbox alone protects your session.

## 1. Standalone with automatic HTTPS

Requirements: ports 80 and 443 free, plus DNS `A`/`AAAA` records for both names pointing at the server.

```bash
curl -fsSL https://raw.githubusercontent.com/dinhkarate/vitrine/main/install.sh \
  | sudo sh -s -- --domain art.example.com --content-domain art-content.example.com --email you@example.com
```

The service runs as a systemd `DynamicUser` with a read-only filesystem except
`/var/lib/vitrine`, and with `CAP_NET_BIND_SERVICE` only. Certificates are cached in
`/var/lib/vitrine/certs`.

```bash
journalctl -u vitrine -f                               # logs and the first-run link
sudo vitrine status --data /var/lib/vitrine            # health, counts
sudo vitrine token  --data /var/lib/vitrine --name ci  # agent token
sudo vitrine passwd --data /var/lib/vitrine            # reset the owner password
```

## 2. Behind nginx, Caddy or Traefik

Let Vitrine listen on localhost and tell it its public URLs:

```bash
vitrine serve --addr 127.0.0.1:8080 \
  --url https://art.example.com --content-url https://art-content.example.com \
  --trust-proxy
```

With the installer: `sudo sh install.sh --url https://art.example.com --content-url https://art-content.example.com`.

Proxy both host names to `127.0.0.1:8080` and keep the `Host` header. Examples:
[`deploy/Caddyfile`](../deploy/Caddyfile) and [`deploy/nginx.conf`](../deploy/nginx.conf).

> Share-link tokens appear in URLs. Vitrine redacts them from its own log, but your proxy's
> access log will record them unless you disable or filter it (`access_log off;` in nginx).

## 3. Docker / Compose

```bash
docker run -d --name vitrine --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -v vitrine:/data \
  -e VITRINE_URL=https://art.example.com \
  -e VITRINE_CONTENT_URL=https://art-content.example.com \
  -e VITRINE_TRUST_PROXY=1 \
  ghcr.io/dinhkarate/vitrine
docker logs vitrine                                  # first-run link
docker exec vitrine /vitrine token --name my-agent   # agent token
```

The image is built `FROM scratch` and runs as a non-root user; it is about 5 MB compressed.
See [`docker-compose.yml`](../docker-compose.yml).

## 4. Home server with Cloudflare Tunnel

No public IP, no open ports, free TLS. You need a domain on Cloudflare (any registrar; the
tunnel itself is free). Quick tunnels (`*.trycloudflare.com`) get a new hostname on every
restart, which breaks passkeys, so use a named tunnel.

```bash
vitrine serve --addr 127.0.0.1:8080 --url https://art.example.com \
  --content-url https://art-content.example.com --trust-proxy=cloudflare
cloudflared tunnel create vitrine
# ~/.cloudflared/config.yml
#   ingress:
#     - hostname: art.example.com
#       service: http://127.0.0.1:8080
#     - hostname: art-content.example.com
#       service: http://127.0.0.1:8080
#     - service: http_status:404
cloudflared tunnel route dns vitrine art.example.com
cloudflared tunnel route dns vitrine art-content.example.com
cloudflared tunnel run vitrine
```

`--trust-proxy=cloudflare` takes the visitor IP from `CF-Connecting-IP` for login rate
limiting. Like every proxy mode, it only trusts the header on connections from loopback or a
private network, so keep vitrine bound to `127.0.0.1` (or a Docker network).

Things to know on the Cloudflare Free plan:

- Uploads are capped at 100 MB by Cloudflare (about 95 MB of files after multipart overhead).
- Don't enable Bot Fight Mode or "I'm Under Attack" on the app hostname; they challenge
  non-browser clients and break `/mcp`, `/api` and the CLI.
- Cloudflare's terms allow it to limit free-plan zones that mostly serve video or large files.
  A gallery of HTML, Markdown and PDFs is fine; don't use it as a video host.

### Optional: Cloudflare Access in front of the app

Cloudflare Zero Trust's free plan can put an extra login (email code, GitHub, Google) in front
of the gallery while share links keep working. Create these Access applications:

| Application | Policy |
|---|---|
| `art.example.com` | Allow: your email |
| `art.example.com/s/*` | Bypass: everyone (public share pages) |
| `art.example.com/assets/*` | Bypass: everyone (share-page styles) |
| `art.example.com/mcp`, `art.example.com/api/*` | Bypass (vitrine's API tokens still apply), or Service Auth if your agents can send `CF-Access-Client-Id`/`-Secret` headers |
| `art-content.example.com` | **None.** Sandboxed artifacts can't send the Access cookie; the content host is already protected by signed view and share tokens |

Then let vitrine check Access too, so a missing policy or a request that reaches the origin
around Cloudflare can't open the gallery:

```bash
vitrine serve ... --cf-access-team https://myteam.cloudflareaccess.com --cf-access-aud <AUD tag>
```

Browser requests to the app host must then carry a valid `Cf-Access-Jwt-Assertion` (RS256,
signed by your team's rotating keys, for this application's AUD tag). Requests with a valid
vitrine API token, share pages, `/assets/*`, `/health` and the content host are not checked.

Simpler: start vitrine with `--shares-on-content`. Share links then live on the content host,
so the app host needs no bypass rules for `/s/*` and `/assets/*`; protect it whole and only
decide what to do with `/mcp` and `/api/*`.

## 5. Home server with Tailscale

Free, and no domain needed: Tailscale gives each machine `name.your-tailnet.ts.net` with HTTPS.

**Private (tailnet only).** Only your own devices can reach vitrine; agents on those devices
use it as usual.

```bash
vitrine serve --addr 127.0.0.1:8080 --url https://box.your-tailnet.ts.net --trust-proxy=tailscale
tailscale serve --bg 8080
```

**Private app, public share links (recommended).** Keep the gallery, API and MCP on your
tailnet and put only share links and artifact files on the Internet with Funnel, on a second
port. A different port is a different origin, so you also get a separate content origin for free.
Enable Funnel in the tailnet policy first.

```bash
vitrine serve --addr 127.0.0.1:8080 --url https://box.your-tailnet.ts.net \
  --content-url https://box.your-tailnet.ts.net:8443 --shares-on-content --trust-proxy=tailscale
tailscale serve  --bg --https=443  http://127.0.0.1:8080   # gallery, API, MCP: your devices only
tailscale funnel --bg --https=8443 http://127.0.0.1:8080   # share links + artifact files: public
```

`--shares-on-content` makes share links use the content origin. On that port vitrine answers
only share pages, their styles and artifact files; the gallery, login, API and MCP return 404
there, so nothing private is reachable from the Internet. Agents on your devices use
`https://box.your-tailnet.ts.net/mcp` as usual.

**Everything public.** Alternatively funnel the single port (`tailscale funnel --bg 8080`): the
whole app is then public, protected by your passkey or password like any other deployment.

Things to know:

- Funnel is free on the Personal plan but still in beta, only uses ports 443, 8443 and 10000,
  and can't use your own domain.
- A machine has one name, so this setup has a single origin; the sandbox still isolates
  artifacts from your session.
- Machine names appear in public certificate-transparency logs. Renaming the machine or the
  tailnet changes the URL, which invalidates registered passkeys (password login still works).

## Free hosting

Vitrine needs roughly 10 MB of RAM and almost no CPU, so free options are plenty. Free-tier
terms change; check the provider's current page before you rely on one.

| Option | Cost | What you get | Notes |
|---|---|---|---|
| **Your own machine + Tailscale** ([§5](#5-home-server-with-tailscale)) | $0, no domain | `*.ts.net` HTTPS, tailnet-only or public via Funnel | Funnel is beta; single origin |
| **Your own machine + Cloudflare Tunnel** ([§4](#4-home-server-with-cloudflare-tunnel)) | $0 + a domain | Two hostnames, no open ports, optional Access login | 100 MB upload cap; quick tunnels break passkeys |
| **Oracle Cloud Always Free** | $0 | AMD micro VMs or Arm Ampere (2 OCPU / 12 GB), 200 GB block storage, 10 TB egress | Idle instances may be reclaimed; Arm capacity is often "out of host capacity" |
| **Google Cloud `e2-micro`** | $0 | 1 VM in `us-west1`, `us-central1` or `us-east1`, 30 GB disk | Only 1 GB/month egress is free, tunnel traffic included; an external IPv4 address is billed |
| **Raspberry Pi / old laptop** | your hardware | Use the `linux_arm64` or `linux_armv7` release with §4 or §5 | |

Platforms with ephemeral disks or no free tier (Render free, Koyeb free, Fly.io for new
accounts, Vercel, Netlify) are **not** suitable: vitrine stores your files on local disk.

## Configuration reference

Every flag has an environment variable.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--data` | `VITRINE_DATA` | `/var/lib/vitrine` if it exists, else `./vitrine-data` | data directory |
| `--addr` | `VITRINE_ADDR` | `:8080` | listen address (ignored with `--domain`) |
| `--url` | `VITRINE_URL` | `http://localhost:8080` | public URL; must match the browser origin for passkeys |
| `--content-url` | `VITRINE_CONTENT_URL` | — | separate origin for artifact content |
| `--domain` | `VITRINE_DOMAIN` | — | built-in HTTPS on :443/:80 with Let's Encrypt |
| `--content-domain` | `VITRINE_CONTENT_DOMAIN` | — | certificate for the content domain too |
| `--email` | `VITRINE_EMAIL` | — | Let's Encrypt contact |
| `--name` | `VITRINE_NAME` | `vitrine` | name shown in the UI |
| `--theme` | `VITRINE_THEME` | `default` | `default`, `terminal`, `paper` |
| `--theme-dir` | `VITRINE_THEME_DIR` | — | directory overriding theme or shell files |
| `--trust-proxy[=MODE]` | `VITRINE_TRUST_PROXY=1\|cloudflare\|tailscale` | off | behind a proxy, take the client IP for rate limiting from `X-Forwarded-For` (bare flag, `xff`), `CF-Connecting-IP` (`cloudflare`) or Tailscale Serve/Funnel (`tailscale`); only trusted on loopback or private-network connections |
| `--max-upload-mb` | `VITRINE_MAX_UPLOAD_MB` | `100` | request size limit |
| `--shares-on-content` | `VITRINE_SHARES_ON_CONTENT=1` | off | serve public share pages from `--content-url`, so everything public is on one host and the app host can stay private; old app-host share links redirect |
| `--cf-access-team`, `--cf-access-aud` | `VITRINE_CF_ACCESS_TEAM`, `VITRINE_CF_ACCESS_AUD` | — | require a valid Cloudflare Access JWT on browser requests to the app host |
| `--webhook` | `VITRINE_WEBHOOK` | — | comma-separated URLs notified on publishes, new versions, new share links and new share visitors; Slack and Discord incoming-webhook URLs work as-is, prefix `ntfy+` for ntfy (e.g. `ntfy+https://ntfy.sh/my-topic`) |
| `--artifact-csp` | `VITRINE_ARTIFACT_CSP` | — | extra CSP for artifacts, e.g. `connect-src 'none'` to block network access |

## Backups and upgrades

```bash
sudo systemctl stop vitrine
sudo tar -C /var/lib -czf vitrine-$(date +%F).tgz private/vitrine   # DynamicUser stores data under /var/lib/private
sudo systemctl start vitrine
```

To upgrade, re-run the install script; your data and settings stay in place.
