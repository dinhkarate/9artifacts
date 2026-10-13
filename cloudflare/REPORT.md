# Cloudflare Workers edition: status

Rebased on `feat/free-hosting`. Not deployed yet.

## What works
- Two Workers: `vitryn` holds D1 (metadata), R2 (files), static assets and an hourly cleanup
  cron; `vitryn-content` forwards to it, giving a separate sandboxed content origin.
- Same REST API and JSON shapes as the Go server, and the same 10 MCP tools (including
  `list_comments` and `resolve_comment`).
- Share pages behave the same: expiry, view limits, passwords, link previews, webhooks.
- Review comments, with the selection script only in the owner's viewer (`?vc=1`).
- MCP OAuth for claude.ai and ChatGPT connectors: discovery, registration, PKCE, rotating
  refresh tokens, CORS.
- `web/` is served unchanged (setup and sign-in forms relabelled on the fly); the Go CLI works
  against it as-is.

## Tests
- `npm test`: 78 vitest tests in workerd, including ports of the Go comment and OAuth tests and
  WebAuthn with a software authenticator. `tsc` is clean.
- Local `wrangler dev` smoke with curl, the Go CLI and Chrome; no Cloudflare login needed.

## Differences from the Go server
- Owners sign in with passkeys only; `SETUP_TOKEN` is the first-run and recovery code.
- Share passwords use PBKDF2 at 10k iterations (Workers' 10 ms CPU limit), which is weaker.
- Upload cap is 50 MB.
- Admin-socket commands and the Cloudflare Access JWT check are not ported.
- The theme is chosen at build time.
- Cloudflare's own request logs show full URLs, including share tokens; Workers Logs is off in
  the config for that reason.

## Not yet verified (needs a Cloudflare account)
- How the Deploy button handles the second Worker.
- Remote migrations against a database that `wrangler deploy` created automatically.

## Deploy
    cd cloudflare && npm ci && npx wrangler login
    npx wrangler r2 bucket create vitryn-files
    openssl rand -base64 32 | npx wrangler secret put SETUP_TOKEN
    npm run deploy
