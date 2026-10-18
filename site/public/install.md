# Install 9artifacts — instructions for AI agents

You are helping a user install **9artifacts**, a self-hosted gallery where AI agents publish
HTML, Markdown, SVG, images and PDFs, and the owner reviews them behind a passkey.
Source: https://github.com/dinhkarate/9artifacts (MIT).

`https://9artifacts.com/install.sh` redirects to
`install.sh` on the `main` branch of that repository; read it there if you want to check it first.

Follow these steps in order. Stop and ask the user whenever something below says *ask*.

## Rules

- Never print, log or paste an API token into the chat. Pipe it straight into the place that
  stores it (an agent config or a secret manager).
- Only touch the server the user named. Show the commands before running anything with `sudo`.
- The first-run setup (password and passkey) is the **user's** job: give them the link, do not
  open it or fill it in yourself. The link's `#code=` makes whoever opens it the owner, so keep
  it out of your own output: every command below that prints it ends in
  `| sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"`, which shows only that the link exists. Give the user the same
  command without the `sed` to run themselves.
- Never create public share links unless the user asks for one.

## 1. Ask the user

1. **Where should it run?**
   - **A Linux VPS** they can reach over SSH (systemd, ports 80/443 free) → section 2A.
   - **A VPS that already runs nginx, Caddy or another proxy on 80/443** → section 2B.
   - **Docker** on any machine → section 2C (also the **local try-out**: no domain, on their own computer).
   - **No server**: Cloudflare Workers free plan → section 2D.
2. **Two hostnames** (not needed for 2D or a local Docker try-out): one for the app and one for artifact content, for
   example `art.example.com` and `art-content.example.com`. The second one isolates artifact
   JavaScript from the app, which is how claude.ai does it.
3. **An email** for Let's Encrypt (2A only).
4. **Which agent to connect** in step 5 (you, or another app such as claude.ai), and a label for
   its token (if they don't care: your agent's name and this machine's, such as `claude-code-laptop`).
   Remote connectors such as claude.ai need the public HTTPS URL, so not a local try-out.
   For Claude Code, also the project directory it should work in (`DIR` in step 5).

If there are hostnames, check before installing that both resolve to the server:

```bash
for h in art.example.com art-content.example.com; do echo "$h: $(dig +short "$h")"; done   # both: the server's IP
# no dig? use getent ahosts "$h" in the same loop
```

If they don't, tell the user which A records to create and wait.

## 2A. VPS, automatic HTTPS

First check for an earlier install: `ssh HOST 'test -e /etc/systemd/system/9artifacts.service && echo installed'`.
If it prints `installed`, ask the user before going on. Also check that nothing else listens on
80 or 443: `ssh HOST 'ss -ltn "( sport = :80 or sport = :443 )"'` must print only its header line. Re-running the installer replaces the
binary and the service file, keeps the data in `/var/lib/9artifacts` and restarts the service.
Older copies of the installer only started it, so after a re-run check
`ssh HOST 'systemctl show 9artifacts -p ActiveEnterTimestamp'`: if that time is from before you
ran the installer, run `ssh -t HOST 'sudo systemctl restart 9artifacts'` so the new binary and
flags load.

```bash
ssh HOST 'curl -fsSL https://9artifacts.com/install.sh \
  | sudo sh -s -- --domain art.example.com --content-domain art-content.example.com --email you@example.com' \
  2>&1 | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"
```

The exit status is `sed`'s, so read the output for errors (or run it under `set -o pipefail`
in bash or zsh). This needs sudo without a password. If sudo asks for one, give the user the command without
the `sed` line, with `ssh -t`, to run in their own terminal.
This installs the binary to `/usr/local/bin/9artifacts`, a hardened `9artifacts.service`, and
gets certificates itself. The output ends with the (hidden) **first-run link**; if it says
"already set up" on a new server instead, it was still starting: step 4 gets the link. Go to step 3.

## 2B. VPS behind your own reverse proxy

Check for an earlier install first, as in 2A, and that nothing else uses port 8080:
`ssh HOST 'ss -ltn "( sport = :8080 )"'` must print only its header line. Sudo works as in 2A.

```bash
ssh HOST 'curl -fsSL https://9artifacts.com/install.sh \
  | sudo sh -s -- --url https://art.example.com --content-url https://art-content.example.com' \
  2>&1 | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"
```

9artifacts then listens on `127.0.0.1:8080`. Proxy both hostnames to it, passing `Host`,
`X-Forwarded-For` and `X-Forwarded-Host` (set by the proxy to the requested host, never passed
through from the client), and allow uploads of up to 100 MB. Do not add `X-Frame-Options` (it breaks
the content iframe). With nginx, the certificate must cover both hostnames (e.g. `certbot -d art.example.com
-d art-content.example.com`). Ready-made configs: https://github.com/dinhkarate/9artifacts/blob/main/deploy/nginx.conf and
https://github.com/dinhkarate/9artifacts/blob/main/deploy/Caddyfile. Then go to step 3.

## 2C. Docker

Run these commands on the Docker host. If that is another machine, open a shell there
(`ssh HOST`) and set `C` and `PORT` in it; step 5 shows how to fetch the token from your side.

Every Docker command in this guide uses two shell variables: `C`, the name of the container,
its volume and its network, and `PORT`, the host port. Set them first (and again in any new
shell; your tool may start a fresh one per command):

```bash
C=9artifacts PORT=8080     # or the user's choice, e.g. C=9artifacts-test PORT=18990
```

The container always listens on 8080 inside, the binary in it is always `/9artifacts`, and the
MCP server name in step 5 stays `9artifacts`.

First check that the name, volume and port are free. An existing `$C` container is an earlier
install or attempt: ask the user before removing it, or pick another `C`. An existing `$C` volume holds an
earlier install with its owner and data: ask the user before reusing it. An existing network
from an earlier attempt can be reused (skip `docker network create`); a local try-out doesn't
use the network, so ignore that line there.

```bash
command -v curl >/dev/null || echo "curl is missing"
docker info >/dev/null && echo "docker OK"
docker container inspect "$C" >/dev/null 2>&1 && echo "container $C exists"
docker volume inspect "$C" >/dev/null 2>&1 && echo "volume $C exists"
docker network inspect "$C" >/dev/null 2>&1 && echo "network $C exists"
rc=0; curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" || rc=$?; [ "$rc" -eq 7 ] || [ "$rc" -eq 127 ] || echo "port $PORT is in use"
```

`docker OK` and nothing else means all are free; without `docker OK` the other lines
mean nothing. If `docker info` fails with a permission
error, the user needs to be in the `docker` group (or you need `sudo`: ask first).

### Local try-out (no domain, no proxy)

Bind to loopback, drop the content URL and
`TRUST_PROXY`, make `NINEARTIFACTS_URL` match the host port you publish, and leave out
`--restart` so it doesn't come back after a reboot:

```bash
docker run -d --name "$C" -p "127.0.0.1:$PORT:8080" -v "$C:/data" \
  -e NINEARTIFACTS_URL="http://localhost:$PORT" \
  ghcr.io/dinhkarate/9artifacts
for i in 1 2 3 4 5 6 7 8 9 10; do docker logs "$C" 2>&1 | grep -q "first run" && break; sleep 1; done
docker logs "$C" 2>&1 | grep "first run" | tail -1 | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"
```

Without a content URL, artifacts share the app's origin but still run sandboxed (no cookies,
no API access); the second origin is extra isolation you can skip on your own machine.
Open it in a browser on the same machine. Passkeys need `localhost` or HTTPS, so a LAN IP won't
work; from another machine use a tunnel such as `ssh -L $PORT:localhost:$PORT HOST`.
Then go to step 3.

### Server with a domain

```bash
docker network create "$C"
docker run -d --name "$C" --network "$C" --restart unless-stopped -p "127.0.0.1:$PORT:8080" -v "$C:/data" \
  -e NINEARTIFACTS_URL=https://art.example.com \
  -e NINEARTIFACTS_CONTENT_URL=https://art-content.example.com \
  -e NINEARTIFACTS_TRUST_PROXY=1 \
  ghcr.io/dinhkarate/9artifacts
for i in 1 2 3 4 5 6 7 8 9 10; do docker logs "$C" 2>&1 | grep -q "first run" && break; sleep 1; done
docker logs "$C" 2>&1 | grep "first run" | tail -1 | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"
```

Put a TLS proxy in front as in 2B, then go to step 3. Keep the `127.0.0.1:` bind: Docker's published ports skip
host firewalls such as ufw, and `TRUST_PROXY` makes the app believe `X-Forwarded-For` and
`X-Forwarded-Host` from any private address, so only the proxy may be able to reach it. The flag itself blocks nobody, and
other containers on the same Docker network can reach it too, so it gets a network of its own.
A proxy in a container joins it with `--network "$C"` and proxies to `http://$C:8080` (the
`127.0.0.1:8080` in the sample configs is for a proxy on the host; change it to
`127.0.0.1:$PORT` if you picked another port).

The loop waits up to 10 seconds for the first-run line. A new code is made on every start until
setup is done, so always use the **last** `first run` line. If none appears,
`docker exec "$C" /9artifacts status | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"` tells you: `"needsSetup": true`
means setup is still pending (its `setupUrl` is the current link), `false` means the volume
already has an owner.

## 2D. Cloudflare Workers (no server)

Send the user to
https://deploy.workers.cloudflare.com/?url=https://github.com/dinhkarate/9artifacts/tree/main/cloudflare
and tell them to set the `SETUP_TOKEN` secret, when asked, to a random string of 16+ characters
that they keep in their password manager. It is the setup code: there is no first-run link.
It stays valid afterwards as a recovery login (it lets the user replace a lost passkey), so it
must never go in the chat, shell history or a file; `npx wrangler secret delete SETUP_TOKEN`
turns that off. If the button doesn't ask for it, the user runs `npx wrangler secret put
SETUP_TOKEN` afterwards (the setup screen says so too).
Leave `WEBHOOKS` empty unless they want publish notifications sent to a URL they own.
If you have Node.js 22+ and `wrangler`, and the user is logged in, you can deploy yourself
instead, but let the user type the secret:

```bash
git clone https://github.com/dinhkarate/9artifacts && cd 9artifacts/cloudflare
npm ci
npx wrangler r2 bucket create 9artifacts-files
npm run deploy
```

Then ask the user to run `npx wrangler secret put SETUP_TOKEN` in that directory and paste the
value from their password manager at its prompt.

The app is at `https://9artifacts.<subdomain>.workers.dev`. There is no server shell, so in
step 5 the user creates the token in **Settings → Connect an AI agent** (after step 4) and
saves it as `export NINEARTIFACTS_TOKEN=…` in `~/.config/9artifacts/token.env` (mode 600) on
the machine you run on. You load it with `. ~/.config/9artifacts/token.env` before each command
that uses it; never ask for the token in the chat.

## 3. Check that it runs

```bash
curl -fsS https://art.example.com/health          # {"ok":true,"version":"..."}
```

On Workers use `https://9artifacts.<subdomain>.workers.dev/health`; if it fails there, the user
checks the Worker's logs in the Cloudflare dashboard (or `npx wrangler tail`).
For a local try-out use `http://localhost:$PORT` here and in step 5 instead of `https://art.example.com`
(the same URL as `NINEARTIFACTS_URL`, or passkeys won't work).

If it fails: `ssh HOST 'sudo journalctl -u 9artifacts -n 50 --no-pager' | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"` (Docker:
`docker logs "$C" 2>&1 | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"`). Docker behind a proxy: finish the proxy first.

## 4. Hand over to the user

Give the user this command, which prints the first-run link (don't run it as written yourself):
`ssh -t HOST 'sudo journalctl -u 9artifacts --no-pager -o cat | grep "first run" | tail -1'`
(Docker: `docker logs "$C" 2>&1 | grep "first run" | tail -1`; when you hand it over, write the
container's real name in place of `"$C"`). To check that it prints a
link, run your own copy with `| sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"` added at the end. Always the
**last** line: each start makes a new code until setup is done. Ask them to
open it, set the owner password and add a passkey in Settings. On Workers (2D) they open the app
URL instead, enter their `SETUP_TOKEN` on the setup screen and add a passkey.
The server writes the link to its log, so anyone who can read the journal or `docker logs`
could claim the owner account first: ask the user to do this soon. If the installer said there
is no link yet, wait a few seconds and use the command above;
`ssh HOST 'sudo /usr/local/bin/9artifacts status --data /var/lib/9artifacts' | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"`
(Docker: `docker exec "$C" /9artifacts status | sed "s/code=[A-Za-z0-9_-]*/code=HIDDEN/"`) shows `needsSetup`. You can do steps 5 and 6
meanwhile (not on Workers: there the token comes from Settings), but don't call the install finished until they confirm: until then nobody can
sign in to view what you publish. If they set up later, report the install as done except for
the owner setup.

## 5. Connect yourself

First check that you have no MCP server called `9artifacts` already (`cd DIR && claude mcp list`,
or your agent's equivalent). If you do, ask the user before replacing it: it may be a real
connection. Then create a token on the server and pipe it straight into your own configuration. Each run makes
a new token; the owner lists and revokes them in Settings. Pick the block
for the agent you are. `HOST` is the SSH host, `NAME` a label such as `claude-code-laptop`.
`token` prints the token alone on stdout and its notice on stderr, so `$(…)` and pipes capture
only the token. Keep stderr: the notice holds no secret, and if the command fails it says why. A token
made on the server works right away, even before the owner finishes step 4: shell access to
the server already means owner access. The commands below put the token on `claude`'s command
line for a moment, where other users of a shared machine could see it; there is no form of
`claude mcp add` that avoids this, so if other people have accounts on this machine (ask the
user when unsure), tell the user before you run it.

The token commands run `sudo` over `ssh` without a terminal, so they need sudo without a
password. If sudo asks for one there, ask the user to run
`sudo /usr/local/bin/9artifacts token --data /var/lib/9artifacts --name NAME` on the server and put the token in
`NINEARTIFACTS_TOKEN`, then use the Workers form below with your URL. On Docker, use
`docker exec "$C" /9artifacts token --name NAME` in place of the `ssh HOST '…'` command in
every block, and `http://localhost:$PORT` for a local try-out.

**Claude Code** — `DIR` is the project directory the user will work in. Each command starts with
`cd DIR` because the `local` scope belongs to the directory it runs in.

```bash
cd DIR && claude mcp add --scope local --transport http 9artifacts https://art.example.com/mcp \
  --header "Authorization: Bearer $(ssh HOST 'sudo /usr/local/bin/9artifacts token --data /var/lib/9artifacts --name NAME')" >/dev/null
```

Docker on this machine (local try-out shown; the container's data dir is the default). For
Docker on another machine, use `$(ssh HOST "docker exec $C /9artifacts token --name NAME")`
(double quotes, so your `C` is filled in) and that server's URL:

```bash
cd DIR && claude mcp add --scope local --transport http 9artifacts "http://localhost:$PORT/mcp" \
  --header "Authorization: Bearer $(docker exec "$C" /9artifacts token --name NAME)" >/dev/null
```

Workers (2D), or any token the user put in `NINEARTIFACTS_TOKEN`:

```bash
. ~/.config/9artifacts/token.env
cd DIR && claude mcp add --scope local --transport http 9artifacts https://9artifacts.SUBDOMAIN.workers.dev/mcp \
  --header "Authorization: Bearer $NINEARTIFACTS_TOKEN" >/dev/null
```

Keep the `local` scope. It stores the token in `~/.claude.json` (keep that file out of bug
reports and dotfile repos); `--scope project` writes it into `.mcp.json`, which usually gets committed; `local` belongs to the current directory, so run later sessions from
there. `>/dev/null` hides the confirmation, which some Claude Code versions print with the header in
it; errors still show. Check that `claude mcp list` shows **✔ Connected**: an empty token (a failed `ssh` or
`docker exec`) still gets added, but won't connect. Don't read `claude mcp get` whole: it
prints the token. `cd DIR && claude mcp get 9artifacts | grep -i scope` shows only the scope,
which should be `Local config`. The new tools appear in the **next** Claude Code session, not the
current one; step 6 tests them with a headless session.

**Codex and Cursor** read the token from `NINEARTIFACTS_TOKEN`. Ask the user where they keep
secrets. With their OK you can store it in a private file without printing it, and they load
it from their shell profile with `. ~/.config/9artifacts/token.env`. Apps started from the Dock or
a menu don't read the shell profile: start Cursor or the Codex app from that shell, or restart
it after the variable is set.

```bash
(umask 077; mkdir -p ~/.config/9artifacts
 printf 'export NINEARTIFACTS_TOKEN=%s\n' "$(ssh HOST 'sudo /usr/local/bin/9artifacts token --data /var/lib/9artifacts --name NAME')" \
   > ~/.config/9artifacts/token.env)
```

**Codex**:

```bash
codex mcp add 9artifacts --url https://art.example.com/mcp --bearer-token-env-var NINEARTIFACTS_TOKEN
```

**Cursor** — merge this entry into `mcpServers` in
`~/.cursor/mcp.json`, keeping the servers already there (not a project's `.cursor/mcp.json`,
which may get committed):

```json
{ "mcpServers": { "9artifacts": { "url": "https://art.example.com/mcp", "headers": { "Authorization": "Bearer ${env:NINEARTIFACTS_TOKEN}" } } } }
```

**claude.ai, ChatGPT and other apps with remote connectors** need no token: once step 4 is
done, tell the user to add a custom connector with the URL `https://art.example.com/mcp` and
approve it with their passkey. They connect from the vendor's cloud, so they need the public
HTTPS URL and can't reach a local try-out.

**Any other agent with a shell** — install the skill and the CLI, and log the CLI in:

```bash
npx skills add dinhkarate/9artifacts
curl -fsSL https://9artifacts.com/install.sh | sh -s -- --no-service   # without root it lands in ~/.local/bin
command -v 9artifacts || export PATH="$HOME/.local/bin:$PATH"           # make sure it runs before making a token
ssh HOST 'sudo /usr/local/bin/9artifacts token --data /var/lib/9artifacts --name NAME' | 9artifacts login https://art.example.com
```

The installer's `9artifacts serve` hint is for running a server; you only need `login`. On
Workers there is no server shell: ask the user to run `9artifacts login https://9artifacts.SUBDOMAIN.workers.dev`
themselves and paste the token from Settings at its prompt.

## 6. Prove it works

Publish a small test page and give the user its private URL (they can open it once step 4 is done).
With Claude Code over MCP, run a headless session from `DIR`:

```bash
cd DIR && claude -p "publish a hello page with 9artifacts and reply with its URL and its heading" \
  --allowedTools mcp__9artifacts < /dev/null
```

`--allowedTools mcp__9artifacts` allows the whole server: the agent reads the design guide
before publishing. It is a full agent run: allow a minute or two and some model usage, and
don't start it twice. Other MCP agents call `publish_artifact` from a new session. With the CLI:

```bash
echo '<title>Hello from your agent</title><h1>9artifacts is connected</h1>' > /tmp/hello.html
9artifacts publish /tmp/hello.html
```

The publish result (or `list_artifacts` / `9artifacts list`) is the proof that it exists. The URL
is private: opened without signing in it answers `200` with the app's sign-in shell, not the
artifact, so a signed-out `curl` only shows that the page's own text is not public.

Then tell the user what they can ask from now on:

- "Make a dashboard of this CSV and publish it to 9artifacts."
- "Update that artifact with the new numbers." (same URL, their open tab reloads)
- "Fix the comments on the Q3 report." (read with `list_comments`, publish, `resolve_comment`)
- "Share it for 7 days with a password." (only when asked)

To remove a try-out, with `C` set to **its** name (check with `docker ps -a` first: the volume
holds the owner account and every artifact, and removing it can't be undone):
`docker rm -f "$C" && docker volume rm "$C"`, and
`cd DIR && claude mcp remove 9artifacts -s local` (or your agent's
equivalent).

More: the agent skill at
https://github.com/dinhkarate/9artifacts/blob/main/skills/9artifacts/SKILL.md and the REST API at
https://github.com/dinhkarate/9artifacts/blob/main/docs/api.md.
