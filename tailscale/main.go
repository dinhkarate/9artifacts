// Command vitrine-ts is vitrine with Tailscale built in: no domain, no open
// ports, no separate tailscaled. One tsnet node serves the gallery, API and
// MCP to your tailnet only (https://NAME.TAILNET.ts.net), and, with Funnel,
// share links and artifact files to the Internet on port 8443 (a separate
// origin). It is a separate build because tsnet adds ~16 MB to the binary.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/dinhkarate/vitrine/internal/app"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

var version = "dev"

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println("vitrine-ts", version)
		return
	}
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	if err := serve(args); err != nil {
		log.Fatal(err)
	}
}

func serve(args []string) error {
	fs := flag.NewFlagSet("vitrine-ts", flag.ExitOnError)
	data := fs.String("data", env("VITRINE_DATA", "./vitrine-data"), "data directory (tailnet state lives in DATA/tsnet)")
	hostname := fs.String("hostname", env("VITRINE_TS_HOSTNAME", "vitrine"), "machine name on your tailnet (part of the URL; renaming breaks passkeys)")
	funnel := fs.Bool("funnel", env("VITRINE_TS_FUNNEL", "1") != "0", "publish share links and artifact files to the Internet on :8443 with Funnel (needs Funnel enabled in the tailnet policy)")
	name := fs.String("name", env("VITRINE_NAME", "vitrine"), "name shown in the UI")
	theme := fs.String("theme", env("VITRINE_THEME", "default"), "built-in theme")
	themeDir := fs.String("theme-dir", env("VITRINE_THEME_DIR", ""), "directory overriding theme files")
	maxMB := fs.Int("max-upload-mb", 100, "maximum upload size in MB")
	webhook := fs.String("webhook", env("VITRINE_WEBHOOK", ""), "comma-separated webhook URLs")
	_ = fs.Parse(args)
	if v, err := strconv.Atoi(env("VITRINE_MAX_UPLOAD_MB", "")); err == nil {
		*maxMB = v
	}

	ts := &tsnet.Server{
		Hostname: *hostname,
		Dir:      filepath.Join(*data, "tsnet"),
		AuthKey:  os.Getenv("TS_AUTHKEY"),
		UserLogf: log.Printf, // login URL on first run
		Logf:     func(string, ...any) {},
	}
	defer ts.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("joining your tailnet as %q (first run: open the login URL below, or set TS_AUTHKEY)", *hostname)
	if _, err := ts.Up(ctx); err != nil {
		return fmt.Errorf("tailscale: %w", err)
	}
	domains := ts.CertDomains()
	if len(domains) == 0 {
		return errors.New("tailscale: no HTTPS name; enable MagicDNS and HTTPS certificates in the admin console")
	}
	host := domains[0]
	cfg := app.Config{
		DataDir: *data, PublicURL: "https://" + host, Name: *name, Theme: *theme, ThemeDir: *themeDir,
		MaxUpload: int64(*maxMB) << 20, Version: version,
	}
	for _, w := range strings.Split(*webhook, ",") {
		if w = strings.TrimSpace(w); w != "" {
			cfg.Webhooks = append(cfg.Webhooks, w)
		}
	}
	if *funnel {
		cfg.ContentURL = "https://" + host + ":8443"
		cfg.SharesOnContent = true
	}
	st, err := app.OpenStore(*data)
	if err != nil {
		return fmt.Errorf("data dir %s: %w", *data, err)
	}
	srv, err := app.New(cfg, st)
	if err != nil {
		return err
	}
	go func() {
		if err := srv.ServeAdmin(); err != nil {
			log.Printf("admin socket disabled: %v", err)
		}
	}()
	defer os.Remove(app.AdminSocketPath(*data))

	log.Printf("vitrine-ts %s — data %s", version, *data)
	if u := srv.SetupURL(); u != "" {
		log.Printf("first run: open %s (from a device on your tailnet) to set the owner password", u)
	}
	base := func() *http.Server {
		return &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Minute, IdleTimeout: 120 * time.Second}
	}
	var servers []*http.Server
	errc := make(chan error, 2)

	private, err := ts.ListenTLS("tcp", ":443")
	if err != nil {
		return fmt.Errorf("tailscale listen :443: %w", err)
	}
	app443 := base()
	servers = append(servers, app443)
	go func() { errc <- app443.Serve(private) }()
	log.Printf("gallery, API and MCP (tailnet only): https://%s  — MCP: https://%s/mcp", host, host)

	if *funnel {
		public, err := ts.ListenFunnel("tcp", ":8443", tsnet.FunnelOnly())
		if err != nil {
			return fmt.Errorf("tailscale funnel :8443 (is Funnel enabled in your tailnet policy?): %w", err)
		}
		pub := base()
		servers = append(servers, pub)
		go func() { errc <- pub.Serve(funnelListener{public}) }()
		log.Printf("share links and artifact files (public, Funnel): https://%s:8443", host)
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

// funnelListener reports the visitor's address (not the Funnel relay's) as
// the connection's remote address, so vitrine's rate limits and view counts
// see real clients.
type funnelListener struct{ net.Listener }

func (l funnelListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if tc, ok := c.(*tls.Conn); ok {
		if fc, ok := tc.NetConn().(*ipn.FunnelConn); ok && fc.Src.IsValid() {
			return srcConn{Conn: tc, src: net.TCPAddrFromAddrPort(fc.Src)}, nil
		}
	}
	return c, nil
}

type srcConn struct {
	net.Conn
	src net.Addr
}

func (c srcConn) RemoteAddr() net.Addr { return c.src }
