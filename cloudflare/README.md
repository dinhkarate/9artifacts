# 9artifacts on Cloudflare Workers

The same 9artifacts, with no server, no domain and no bill: it runs on the Cloudflare Workers free
plan, with **D1** holding metadata and **R2** holding file bytes. It speaks the Go server's HTTP API,
MCP endpoint and web UI, so the `web/` app, the `9artifacts` CLI, the agent skill and
`claude mcp add` all work against it unchanged.

```
9artifacts.<you>.workers.dev          app: gallery, REST API, /mcp, share pages
9artifacts-content.<you>.workers.dev  sandboxed artifact bytes (/c/…, /s/…/f/…)
```

It includes review comments (the owner comments in the viewer, and agents read them with
`list_comments` and resolve them with `resolve_comment`). It also includes **remote MCP with
OAuth**, so you can add `https://9artifacts.<you>.workers.dev/mcp` as a connector in claude.ai or
ChatGPT. They register themselves and you approve them on a consent page.

The content Worker owns no data. It forwards every request to `9artifacts` over a service binding,
and `9artifacts` serves only sandboxed content on that host, the same host separation the Go server
does with `--content-url`.

## Deploy with one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dinhkarate/9artifacts/tree/main/cloudflare)

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dinhkarate/9artifacts/tree/main/cloudflare)
```

The button URL is `https://deploy.workers.cloudflare.com/?url=<public GitHub URL of this
directory>`, in the form `…/tree/<branch>/cloudflare`. **The repository must be public.**
Cloudflare clones it into your account, creates the D1 database and the R2 bucket named in
`wrangler.jsonc`, and runs `npm run deploy`, which builds, deploys `9artifacts`, applies the D1
migrations and deploys `9artifacts-content`. When it asks for secrets (listed in
`.dev.vars.example`), set `SETUP_TOKEN`. If you skip that step, run
`npx wrangler secret put SETUP_TOKEN` afterwards.

## Deploy by hand

```bash
cd cloudflare
npm ci
npx wrangler login
npx wrangler r2 bucket create 9artifacts-files
npx wrangler d1 create 9artifacts          # optional: `wrangler deploy` creates it otherwise;
                                        # if you run it, add "database_id" to wrangler.jsonc
openssl rand -base64 32 | npx wrangler secret put SETUP_TOKEN
npm run deploy                          # deploy 9artifacts, migrate D1, deploy 9artifacts-content
```

Then open `https://9artifacts.<you>.workers.dev`, enter the setup token, and add a passkey on the
Settings page. To connect claude.ai or ChatGPT, add `https://9artifacts.<you>.workers.dev/mcp` as a
custom connector and approve it while signed in. Create an API token on the same page for your agents:

```bash
claude mcp add --transport http 9artifacts https://9artifacts.<you>.workers.dev/mcp \
  --header "Authorization: Bearer vt_..."
NINEARTIFACTS_URL=https://9artifacts.<you>.workers.dev NINEARTIFACTS_TOKEN=vt_... 9artifacts publish report.html
```

`npm run deploy` runs these steps:

1. `npm run build`: copies `../web` (shell plus theme) into `dist/public/assets` and `src/generated/`.
2. `wrangler deploy`: deploys the `9artifacts` Worker and provisions D1 and R2 if needed.
3. `wrangler d1 migrations apply DB --remote`: creates or updates the tables.
4. `wrangler deploy -c wrangler.content.jsonc`: deploys `9artifacts-content`. It has to come after
   `9artifacts`, because it binds to that Worker.

### Settings (`vars` in `wrangler.jsonc`, secrets with `wrangler secret put`)

| Name | Default | |
|---|---|---|
| `SETUP_TOKEN` (secret) | none | First-run and recovery code, 16 or more characters. Delete it (`wrangler secret delete SETUP_TOKEN`) to turn recovery off. |
| `WEBHOOKS` (secret) | none | Webhook URLs, comma-separated; same events and payloads as `--webhook`. |
| `PUBLIC_URL` | the request origin | Set it when you use a custom domain. |
| `CONTENT_URL` | `auto` | `auto` = `<worker>-content.<you>.workers.dev` on workers.dev (single origin elsewhere); `""` = single origin; or a URL. |
| `SHARES_ON_CONTENT` | off | `1`: public share pages live on the content origin (`--shares-on-content`). |
| `MAX_UPLOAD_MB` | `50` | Multipart upload cap (JSON and MCP bodies stay at 32 MB). |
| `ARTIFACT_CSP` | none | Extra CSP directives for artifact content (`--artifact-csp`). |
| `NAME` | `9artifacts` | Brand shown in the UI. |
| `DEMO` | off | `1`: public read-only demo. Visitors browse the gallery, open artifacts and read comments without signing in; they never see private notes or share links, and every change returns 403. The owner signs in at `/login` with the setup token. |
| `NINEARTIFACTS_THEME`, `NINEARTIFACTS_THEME_DIR` (build env) | `default` | Build-time `--theme` and `--theme-dir`. |

If you rename the Workers, keep the content Worker's name as `<app name>-content`, or set
`CONTENT_URL` explicitly. Update the `service` field in `wrangler.content.jsonc` to match.

## The public demo

[demo.9artifacts.com](https://demo.9artifacts.com) is this Worker with `DEMO=1`, configured in
`demo/wrangler.jsonc` and `demo/wrangler.content.jsonc` (custom domains `demo.9artifacts.com` and
`demo-content.9artifacts.com`, D1 `9artifacts-demo`, R2 `9artifacts-demo-files`):

```bash
npx wrangler r2 bucket create 9artifacts-demo-files
openssl rand -base64 32 | npx wrangler secret put SETUP_TOKEN -c demo/wrangler.jsonc
npm run deploy:demo
```

Sign in at `https://demo.9artifacts.com/login` with the setup token, create an API token in
Settings, and publish the sample artifacts with it.

## Develop and test locally (no Cloudflare account)

```bash
cp .dev.vars.example .dev.vars        # set SETUP_TOKEN
npm run dev                           # http://localhost:8787 (local D1/R2 under .wrangler/)
npm test                              # vitest inside the Workers runtime (@cloudflare/vitest-pool-workers)
npm run typecheck
```

To try two origins locally, add `PUBLIC_URL=http://localhost:8787` and
`CONTENT_URL=http://127.0.0.1:8787` to `.dev.vars`. The same Worker then treats `127.0.0.1` as
the content host. `wrangler dev` prints its own request log with full URLs, share tokens
included. Pass `--log-level warn` if that matters to you.

## Free-plan limits

| Limit (Workers Free) | What it means here |
|---|---|
| 100,000 requests/day | Every page, API call and artifact file counts. Static `/assets/*` files are served without running the Worker. A content-origin request goes through two Workers. |
| 10 ms CPU per request | No 600k-iteration PBKDF2, so owner sign-in is passkey-only (see below). Uploads are streamed, and R2/D1 waits don't count as CPU. Very large JSON or base64 uploads can exceed it, so use multipart. |
| 128 MB memory | Files over 8 MiB go to R2 as multipart uploads in 8 MiB parts, so memory stays bounded. |
| 100 MB request body | Cloudflare's cap. 9artifacts caps multipart at `MAX_UPLOAD_MB` (50). |
| 1,000 D1/R2 operations per request | Up to 500 files per version. Kept and restored files are referenced, never copied. |
| 3 MB Worker size (compressed) | The app Worker is about 40 KB gzipped. |
| D1 5 GB, R2 10 GB storage | Free-tier storage. R2 egress is free. |

## Differences from the Go server

- **Owners sign in with passkeys only.** There are no owner passwords, because PBKDF2 at 600k
  iterations cannot run in 10 ms of CPU. The `SETUP_TOKEN` secret opens a session on the setup
  screen so you can register the first passkey. It also works as a rate-limited recovery code
  in the sign-in form's (relabelled) field, which lets you add a new passkey if you lose yours.
  The same lockouts apply as for Go passwords: 5 failures per address, plus a global cap of 50.
  `/api/password` returns 400.
- **`web/` is reused unchanged.** The Worker renders `index.html` and `share.html` with a small
  Go-template interpreter and uses HTMLRewriter to relabel the setup and sign-in forms. It also
  hides the Settings → Password panel. `app.js` is untouched.
- **Share passwords use weaker hashing.** They are hashed with PBKDF2-SHA256 at 10,000 iterations
  instead of 600,000, in the same encoded format. If the D1 database leaked, they would be much
  easier to brute-force offline. Online guesses are rate-limited as before.
- **The upload cap is 50 MB by default**, instead of 100 MB.
- **There is no `9artifacts token`, `9artifacts passwd` or `9artifacts status`.** Those talk to the Go
  server's admin socket. Create tokens in Settings instead.
- **Cloudflare Access JWT checks (`--cf-access-*`) are not ported.** You can still put Access in
  front of the workers.dev URL. If you do, bypass `/mcp`, `/api` and the content host for agents.
- **Themes are chosen at build time** (`NINEARTIFACTS_THEME`, `NINEARTIFACTS_THEME_DIR`), not at runtime.
- **State is shared through D1.** Lockouts, passkey challenges, OAuth authorization codes and
  the hourly visit dedupe live in D1, because Worker isolates share no memory. An hourly cron
  removes expired rows.
- **The `?vc=1` selection script.** Like Go, it is added only to HTML and rendered Markdown on the
  owner's view-token URLs, never to downloads or share links. Those HTML responses are read
  whole, up to 16 MB.
- **New version numbers are reserved before upload.** A failed upload usually releases its
  number. If two agents publish at once, both versions are kept, where Go would return 409 for
  one of them.
- **Logging differs.** 9artifacts's own log line redacts share, view and grant tokens, as in Go.
  Cloudflare's tooling records full URLs (`wrangler tail`, Workers Logs, `wrangler dev`'s request
  log). `observability` is off in `wrangler.jsonc` for that reason.
- **`/api/me` has two extra fields**, `edition: "cloudflare"` and `passkeyOnly: true`.
- **OAuth connectors are on parity with Go.** They use the same endpoints, PKCE S256 only, 1-hour
  access tokens and rotating 90-day refresh tokens. The consent page needs a passkey session,
  which the setup token can also open.

The parts of the name used in identifiers (cookie names, the MCP server name, the viewer's
`postMessage` key, the User-Agent) come from one constant, `src/brand.ts`. The displayed name is
the `NAME` variable.

Data layout: D1 tables are in `migrations/` (`0001_init.sql`, `0002_comments_oauth.sql`). Files are stored in R2 under
`artifacts/<id>/v<n>/<path>`. A file kept or restored from an earlier version points at that
version's object.
