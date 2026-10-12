# Security policy

vitrine stores documents people consider private, so security reports are welcome and taken
seriously.

## Reporting

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/dinhkarate/vitrine/security/advisories/new).
You should get a reply within a few days. Include steps to reproduce, the affected version
(`vitrine version`), and your deployment mode (built-in TLS, behind a proxy, Docker).

## Supported versions

Only the latest release receives fixes.

## Threat model in brief

- **Artifacts are untrusted.** They may contain hostile JavaScript. They must never be able
  to read the owner's session, call the API, or read other artifacts. Defences: CSP sandbox,
  an optional separate content origin, and per-version view tokens.
- **Public links are capabilities.** Anyone holding one can read that artifact until it
  expires or is revoked. Links always expire.
- **API tokens are full-access** to artifacts, but cannot manage tokens, passkeys or the password.
- **Local admin socket** (`<data>/admin.sock`, mode 0600) trusts whoever can read the data
  directory, which is already the owner.

Out of scope: denial of service by an authenticated owner, and attacks that need root on the host.
