# Contributing

Thanks for helping! A few principles keep Glasshelf what it is:

- **Small and dependency-light.** The only module dependency is `golang.org/x/crypto`
  (ACME). The web UI is plain HTML/CSS/JS with no build step. Please keep it that way.
- **Secure by default.** Anything that serves artifact bytes must keep the sandbox CSP and
  stay on the content origin. Public links must always expire.
- **One owner.** Glasshelf is a personal vault, not a multi-tenant SaaS.

## Development

```bash
go run ./cmd/glasshelf serve --data ./glasshelf-data --url http://localhost:8080
go test ./...          # includes WebAuthn, sandbox, share and MCP tests
gofmt -l . && go vet ./...
```

The UI is embedded from `web/`. Restart the server to pick up changes, or run with
`--theme-dir web` to serve shell files from disk while you iterate.

## Pull requests

- One topic per PR, with tests for server changes.
- Describe user-visible changes in the PR description.
- For new themes, add `web/themes/<name>/theme.css` (and optionally `markdown.css`), plus a
  screenshot in the PR.
