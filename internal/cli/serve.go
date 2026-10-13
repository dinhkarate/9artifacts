// Package cli implements the vitrine subcommands.
package cli

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/dinhkarate/vitrine/internal/app"
	"github.com/dinhkarate/vitrine/web"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func defaultDataDir() string {
	if v := os.Getenv("VITRINE_DATA"); v != "" {
		return v
	}
	if st, err := os.Stat("/var/lib/vitrine"); err == nil && st.IsDir() {
		return "/var/lib/vitrine"
	}
	return "./vitrine-data"
}

// Serve runs the HTTP server.
func Serve(args []string, version string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", env("VITRINE_ADDR", ":8080"), "listen address (ignored with --domain)")
	data := fs.String("data", defaultDataDir(), "data directory")
	public := fs.String("url", env("VITRINE_URL", ""), "public URL users browse, e.g. https://art.example.com")
	content := fs.String("content-url", env("VITRINE_CONTENT_URL", ""), "separate origin for artifact content, e.g. https://art-usercontent.example.com (recommended)")
	domain := fs.String("domain", env("VITRINE_DOMAIN", ""), "serve HTTPS on :443 with automatic Let's Encrypt certificates for this domain")
	contentDomain := fs.String("content-domain", env("VITRINE_CONTENT_DOMAIN", ""), "with --domain: also get a certificate for this content domain")
	email := fs.String("email", env("VITRINE_EMAIL", ""), "with --domain: contact email for Let's Encrypt")
	name := fs.String("name", env("VITRINE_NAME", "vitrine"), "name shown in the UI")
	theme := fs.String("theme", env("VITRINE_THEME", "default"), "built-in theme: "+strings.Join(builtinThemes(), ", "))
	themeDir := fs.String("theme-dir", env("VITRINE_THEME_DIR", ""), "directory overriding theme files (see vitrine theme init)")
	trust := proxyMode(env("VITRINE_TRUST_PROXY", ""))
	fs.Var(&trust, "trust-proxy", "behind a proxy: take the client IP from X-Forwarded-For (bare flag or xff), CF-Connecting-IP (cloudflare) or Tailscale Serve/Funnel (tailscale)")
	maxMB := fs.Int("max-upload-mb", atoiDef(env("VITRINE_MAX_UPLOAD_MB", "100"), 100), "maximum upload size in MB")
	sharesOnContent := fs.Bool("shares-on-content", env("VITRINE_SHARES_ON_CONTENT", "") == "1", "serve public share pages from --content-url, so the app host can stay private (Tailscale, Cloudflare Access)")
	webhook := fs.String("webhook", env("VITRINE_WEBHOOK", ""), "comma-separated URLs to notify on publishes, shares and share visits (Slack, Discord, any JSON endpoint; prefix ntfy+ for ntfy)")
	artifactCSP := fs.String("artifact-csp", env("VITRINE_ARTIFACT_CSP", ""), "extra CSP directives for artifact pages, e.g. \"connect-src 'none'\"")
	_ = fs.Parse(args)

	if *domain != "" {
		*public = "https://" + *domain
		if *contentDomain != "" {
			*content = "https://" + *contentDomain
		}
	}
	st, err := app.OpenStore(*data)
	if err != nil {
		return fmt.Errorf("data dir %s: %w", *data, err)
	}
	srv, err := app.New(app.Config{
		DataDir: *data, PublicURL: *public, ContentURL: *content, Name: *name, Theme: *theme, ThemeDir: *themeDir,
		TrustProxy: string(trust), MaxUpload: int64(*maxMB) << 20, Version: version, ArtifactCSP: *artifactCSP,
		Webhooks: splitList(*webhook), SharesOnContent: *sharesOnContent,
	}, st)
	if err != nil {
		return err
	}
	go func() {
		if err := srv.ServeAdmin(); err != nil {
			log.Printf("admin socket disabled: %v", err)
		}
	}()
	defer os.Remove(app.AdminSocketPath(*data))

	log.Printf("vitrine %s — data %s", version, *data)
	if u := srv.SetupURL(); u != "" {
		log.Printf("first run: open %s to set the owner password", u)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	base := func(h http.Handler) *http.Server {
		return &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Minute, IdleTimeout: 120 * time.Second}
	}
	var servers []*http.Server
	errc := make(chan error, 2)
	if *domain != "" {
		m := &autocert.Manager{
			Prompt: autocert.AcceptTOS, Email: *email,
			Cache:      autocert.DirCache(filepath.Join(*data, "certs")),
			HostPolicy: autocert.HostWhitelist(srv.Hosts()...),
		}
		https := base(srv)
		https.Addr = ":443"
		https.TLSConfig = &tls.Config{GetCertificate: m.GetCertificate, MinVersion: tls.VersionTLS12, NextProtos: []string{"h2", "http/1.1", "acme-tls/1"}}
		http80 := base(m.HTTPHandler(nil))
		http80.Addr = ":80"
		servers = append(servers, https, http80)
		go func() { errc <- https.ListenAndServeTLS("", "") }()
		go func() { errc <- http80.ListenAndServe() }()
		log.Printf("listening on :443 and :80 for %s", strings.Join(srv.Hosts(), ", "))
	} else {
		h := base(srv)
		h.Addr = *addr
		servers = append(servers, h)
		go func() { errc <- h.ListenAndServe() }()
		log.Printf("listening on %s — public URL %s", *addr, displayURL(*public))
	}
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	return nil
}

func displayURL(u string) string {
	if u == "" {
		return "http://localhost:8080 (set --url for passkeys on a real domain)"
	}
	return u
}

func atoiDef(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil && n > 0 {
		return n
	}
	return def
}

func builtinThemes() []string {
	entries, _ := fs.ReadDir(web.FS, "themes")
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}

// ---------- admin commands (talk to the running server's Unix socket) ----------

func adminClient(data string) (*http.Client, error) {
	sock := app.AdminSocketPath(data)
	if _, err := os.Stat(sock); err != nil {
		return nil, fmt.Errorf("no running server found at %s (is vitrine serve running with --data %s? are you the right user?)", sock, data)
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", sock)
		},
	}}, nil
}

func adminDo(data, method, path string, body any, out any) error {
	c, err := adminClient(data)
	if err != nil {
		return err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, "http://admin"+path, rd)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return decodeResp(resp, out)
}

func dataFlag(name string, args []string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	data := fs.String("data", defaultDataDir(), "data directory of the running server")
	return fs, data
}

// Token creates an API token via the admin socket.
func Token(args []string) error {
	fs, data := dataFlag("token", args)
	name := fs.String("name", "agent", "label for the token")
	_ = fs.Parse(args)
	var out struct{ ID, Name, Token string }
	if err := adminDo(*data, "POST", "/token", map[string]string{"name": *name}, &out); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Created token %q. It is shown once — store it in your agent's secret store.\n", out.Name)
	fmt.Println(out.Token)
	return nil
}

// Passwd sets the owner password via the admin socket.
func Passwd(args []string) error {
	fs, data := dataFlag("passwd", args)
	_ = fs.Parse(args)
	pw, err := readSecret("New owner password (min 10 chars): ")
	if err != nil {
		return err
	}
	if term(os.Stdin) {
		again, err := readSecret("Repeat: ")
		if err != nil {
			return err
		}
		if again != pw {
			return errors.New("passwords do not match")
		}
	}
	if err := adminDo(*data, "POST", "/password", map[string]string{"password": pw}, nil); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Password updated; all browser sessions were signed out.")
	return nil
}

// Status prints server status via the admin socket.
func Status(args []string) error {
	fs, data := dataFlag("status", args)
	_ = fs.Parse(args)
	var out map[string]any
	if err := adminDo(*data, "GET", "/status", nil, &out); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
	return nil
}

// Theme exports theme files for customisation.
func Theme(args []string) error {
	if len(args) < 1 || args[0] != "init" {
		return errors.New("usage: vitrine theme init DIR [--from default] [--full]")
	}
	fs := flag.NewFlagSet("theme init", flag.ExitOnError)
	from := fs.String("from", "default", "built-in theme to start from: "+strings.Join(builtinThemes(), ", "))
	full := fs.Bool("full", false, "also export the app shell (index.html, app.js, app.css, share.html)")
	rest := args[1:]
	var dir string
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		dir, rest = rest[0], rest[1:]
	}
	_ = fs.Parse(rest)
	if dir == "" && fs.NArg() > 0 {
		dir = fs.Arg(0)
	}
	if dir == "" {
		return errors.New("usage: vitrine theme init DIR")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	write := func(name string, b []byte) error {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			fmt.Fprintf(os.Stderr, "skip %s (exists)\n", p)
			return nil
		}
		fmt.Fprintf(os.Stderr, "wrote %s\n", p)
		return os.WriteFile(p, b, 0o644)
	}
	names := map[string]bool{}
	for _, theme := range []string{*from, "default"} {
		entries, err := fs2(web.FS, "themes/"+theme)
		if err != nil {
			if theme == *from {
				return fmt.Errorf("unknown theme %q", *from)
			}
			continue
		}
		for _, e := range entries {
			if names[e] {
				continue
			}
			names[e] = true
			b, _ := web.FS.ReadFile("themes/" + theme + "/" + e)
			if err := write(e, b); err != nil {
				return err
			}
		}
	}
	if *full {
		for _, f := range []string{"index.html", "app.js", "app.css", "share.html"} {
			b, _ := web.FS.ReadFile(f)
			if err := write(f, b); err != nil {
				return err
			}
		}
	}
	fmt.Fprintf(os.Stderr, "\nRestart with: vitrine serve --theme-dir %s\nThen ask your AI: \"Restyle %s/theme.css to look like <brand>, and update design.md to match.\"\n", dir, dir)
	return nil
}

func fs2(f fs.FS, dir string) ([]string, error) {
	entries, err := fs.ReadDir(f, dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

// ---------- terminal helpers ----------

func term(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// readSecret reads one line without echo when stdin is a terminal.
func readSecret(prompt string) (string, error) {
	if term(os.Stdin) {
		fmt.Fprint(os.Stderr, prompt)
		off := exec.Command("stty", "-echo")
		off.Stdin = os.Stdin
		if off.Run() == nil {
			defer func() {
				on := exec.Command("stty", "echo")
				on.Stdin = os.Stdin
				_ = on.Run()
				fmt.Fprintln(os.Stderr)
			}()
		}
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no input")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// proxyMode is --trust-proxy: a bare flag means "xff", or name the proxy.
type proxyMode string

func (p *proxyMode) String() string   { return string(*p) }
func (p *proxyMode) IsBoolFlag() bool { return true }
func (p *proxyMode) Set(v string) error {
	*p = proxyMode(v)
	return nil
}

func splitList(v string) []string {
	var out []string
	for _, x := range strings.Split(v, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}
