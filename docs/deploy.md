# Deploying vitrine

vitrine is a single binary that keeps all its state in one data directory.
Pick the setup that matches your server.

- [1. Standalone with automatic HTTPS](#1-standalone-with-automatic-https) (simplest)
- [2. Behind nginx, Caddy or Traefik](#2-behind-nginx-caddy-or-traefik)
- [3. Docker / Compose](#3-docker--compose)
- [4. Home server or laptop with Cloudflare Tunnel](#4-home-server-with-cloudflare-tunnel)
- [Free hosting](#free-hosting)
- [Configuration reference](#configuration-reference)
- [Backups and upgrades](#backups-and-upgrades)

## Two domains (recommended)

Artifacts are untrusted HTML. vitrine always sandboxes them, but serving them from a
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

Let vitrine listen on localhost and tell it its public URLs:

```bash
vitrine serve --addr 127.0.0.1:8080 \
  --url https://art.example.com --content-url https://art-content.example.com \
  --trust-proxy
```

With the installer: `sudo sh install.sh --url https://art.example.com` (then add
`--content-url` to `ExecStart` in `/etc/systemd/system/vitrine.service`).

Proxy both host names to `127.0.0.1:8080` and keep the `Host` header. Examples:
[`deploy/Caddyfile`](../deploy/Caddyfile) and [`deploy/nginx.conf`](../deploy/nginx.conf).

> Share-link tokens appear in URLs. vitrine redacts them from its own log, but your proxy's
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

No public IP, no open ports, free TLS:

```bash
vitrine serve --addr 127.0.0.1:8080 --url https://art.example.com \
  --content-url https://art-content.example.com --trust-proxy
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

Cloudflare puts the visitor IP in `CF-Connecting-IP`/`X-Forwarded-For`, so keep
`--trust-proxy` on for login rate limiting.

## Free hosting

vitrine needs roughly 10 MB of RAM and almost no CPU, so free tiers are plenty. Free-tier
terms change; check the provider's current page before you rely on one.

| Option | What you get | Notes |
|---|---|---|
| **Oracle Cloud Always Free** | AMD micro VMs and Arm Ampere capacity, 200 GB block storage | Arm capacity is often "out of host capacity" in popular regions, so retry or use the AMD micro. |
| **Google Cloud `e2-micro`** | 1 always-free VM in `us-west1`, `us-central1` or `us-east1`, 30 GB disk | An external IPv4 address is billed separately; put it behind a Cloudflare Tunnel to avoid that. |
| **Raspberry Pi / old laptop + Cloudflare Tunnel** | Your hardware, free tunnel and TLS | Use the `linux_arm64` or `linux_armv7` release. |
| **AWS / Azure free trials** | 12-month micro instances | Fine for trying it out. |

Serverless platforms with ephemeral disks (Render free, Vercel, Netlify) are **not**
suitable: vitrine stores your files on local disk.

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
| `--trust-proxy` | `VITRINE_TRUST_PROXY=1` | off | use `X-Forwarded-For` for rate limiting |
| `--max-upload-mb` | `VITRINE_MAX_UPLOAD_MB` | `100` | request size limit |
| `--artifact-csp` | `VITRINE_ARTIFACT_CSP` | — | extra CSP for artifacts, e.g. `connect-src 'none'` to block network access |

## Backups and upgrades

```bash
sudo systemctl stop vitrine
sudo tar -C /var/lib -czf vitrine-$(date +%F).tgz private/vitrine   # DynamicUser stores data under /var/lib/private
sudo systemctl start vitrine
```

To upgrade, re-run the install script; your data and settings stay in place.
