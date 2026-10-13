// Package app is the vitrine HTTP server: a private, passkey-protected
// gallery for HTML/Markdown/PDF artifacts with expiring public share links.
package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/dinhkarate/vitrine/internal/webauthn"
	"github.com/dinhkarate/vitrine/web"
)

// Config holds the server settings, mostly from flags or environment.
type Config struct {
	DataDir     string
	PublicURL   string // origin users browse, e.g. https://art.example.com
	ContentURL  string // optional separate origin for artifact bytes
	Name        string // brand shown in the UI
	Theme       string // built-in theme name
	ThemeDir    string // optional directory overriding theme and shell files
	TrustProxy  string // "", "xff", "cloudflare" or "tailscale": which proxy header carries the client IP
	MaxUpload   int64
	Version     string
	ArtifactCSP string   // extra CSP directives appended for artifact content
	Webhooks    []string // URLs notified of publishes, shares and share visits ("ntfy+https://…" for ntfy)
}

// Server is the vitrine HTTP handler.
type Server struct {
	cfg       Config
	store     *Store
	rp        webauthn.RP
	appHost   string
	contHost  string // empty when content shares the app origin
	setupCode string
	signKey   []byte // immutable copy of State.SigningKey, safe to use under the store lock
	mux       *http.ServeMux

	mu         sync.Mutex
	challenges map[string]challenge
	failures   map[string]*failure
	global     failure // password failures from all addresses
	begins     map[string]*failure
	viewers    map[string]time.Time // share token|client IP → last counted view
}

type challenge struct {
	kind, value string
	expires     time.Time
}

type failure struct {
	count       int
	first, lock time.Time
}

const (
	sessionCookie = "vitrine_session"
	sessionTTL    = 30 * 24 * time.Hour
	viewTTL       = 12 * time.Hour
)

// New builds a server around an opened store.
func New(cfg Config, st *Store) (*Server, error) {
	if cfg.PublicURL == "" {
		cfg.PublicURL = "http://localhost:8080"
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	cfg.ContentURL = strings.TrimRight(cfg.ContentURL, "/")
	if cfg.Name == "" {
		cfg.Name = "vitrine"
	}
	if cfg.Theme == "" {
		cfg.Theme = "default"
	}
	if cfg.MaxUpload <= 0 {
		cfg.MaxUpload = 100 << 20
	}
	for _, hook := range cfg.Webhooks {
		u, err := url.Parse(strings.TrimPrefix(hook, "ntfy+"))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, fmt.Errorf("invalid webhook URL for host %q (use https://… or ntfy+https://…)", hookHost(hook))
		}
	}
	switch strings.ToLower(cfg.TrustProxy) {
	case "", "0", "false", "off":
		cfg.TrustProxy = ""
	case "1", "true", "on", "xff":
		cfg.TrustProxy = "xff"
	case "cloudflare", "tailscale":
		cfg.TrustProxy = strings.ToLower(cfg.TrustProxy)
	default:
		return nil, fmt.Errorf("invalid trust-proxy mode %q (use xff, cloudflare or tailscale)", cfg.TrustProxy)
	}
	pub, err := url.Parse(cfg.PublicURL)
	if err != nil || pub.Host == "" {
		return nil, fmt.Errorf("invalid public URL %q", cfg.PublicURL)
	}
	s := &Server{
		cfg:        cfg,
		store:      st,
		rp:         webauthn.RP{ID: pub.Hostname(), Origin: pub.Scheme + "://" + pub.Host},
		appHost:    strings.ToLower(pub.Host),
		challenges: map[string]challenge{},
		failures:   map[string]*failure{},
		begins:     map[string]*failure{},
		viewers:    map[string]time.Time{},
	}
	if cfg.ContentURL != "" {
		cu, err := url.Parse(cfg.ContentURL)
		if err != nil || cu.Host == "" {
			return nil, fmt.Errorf("invalid content URL %q", cfg.ContentURL)
		}
		if strings.EqualFold(cu.Host, pub.Host) {
			return nil, errors.New("content URL must use a different host than the public URL")
		}
		s.contHost = strings.ToLower(cu.Host)
	}
	if _, err := s.themeFile("theme.css"); err != nil {
		return nil, fmt.Errorf("theme %q: %w", cfg.Theme, err)
	}
	st.Read(func(state *State) {
		s.signKey = state.SigningKey
		if state.PasswordHash == "" {
			s.setupCode = newID(8)
		}
	})
	s.routes()
	return s, nil
}

// SetupURL returns the one-time first-run URL, or "" once a password exists.
func (s *Server) SetupURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setupCode == "" {
		return ""
	}
	return s.cfg.PublicURL + "/setup#code=" + s.setupCode
}

// Hosts lists the host names the server answers for (for TLS certificates).
func (s *Server) Hosts() []string {
	hosts := []string{hostOnly(s.appHost)}
	if s.contHost != "" {
		hosts = append(hosts, hostOnly(s.contHost))
	}
	return hosts
}

func hostOnly(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}

func (s *Server) routes() {
	m := http.NewServeMux()
	// App shell and theme.
	for _, p := range []string{"GET /{$}", "GET /a/{id}", "GET /settings", "GET /setup", "GET /login"} {
		m.HandleFunc(p, s.handleIndex)
	}
	m.HandleFunc("GET /assets/{name}", s.handleAsset)
	m.HandleFunc("GET /design.md", s.handleDesign)
	m.HandleFunc("GET /template.html", s.handleTemplate)
	m.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": s.cfg.Version})
	})
	// Auth.
	m.HandleFunc("GET /api/me", s.handleMe)
	m.HandleFunc("POST /api/auth/setup", s.handleSetup)
	m.HandleFunc("POST /api/auth/login", s.handleLogin)
	m.HandleFunc("POST /api/auth/logout", s.handleLogout)
	m.HandleFunc("POST /api/auth/passkey/login/begin", s.handlePasskeyLoginBegin)
	m.HandleFunc("POST /api/auth/passkey/login/finish", s.handlePasskeyLoginFinish)
	m.HandleFunc("POST /api/passkeys/begin", s.session(s.handlePasskeyRegisterBegin))
	m.HandleFunc("POST /api/passkeys/finish", s.session(s.handlePasskeyRegisterFinish))
	m.HandleFunc("GET /api/passkeys", s.session(s.handlePasskeyList))
	m.HandleFunc("DELETE /api/passkeys/{id}", s.session(s.handlePasskeyDelete))
	m.HandleFunc("POST /api/password", s.session(s.handlePasswordChange))
	m.HandleFunc("GET /api/tokens", s.session(s.handleTokenList))
	m.HandleFunc("POST /api/tokens", s.session(s.handleTokenCreate))
	m.HandleFunc("DELETE /api/tokens/{id}", s.session(s.handleTokenDelete))
	// Artifacts.
	m.HandleFunc("GET /api/artifacts", s.auth(s.handleList))
	m.HandleFunc("POST /api/artifacts", s.auth(s.handleCreate))
	m.HandleFunc("GET /api/artifacts/{id}", s.auth(s.handleGet))
	m.HandleFunc("PATCH /api/artifacts/{id}", s.auth(s.handlePatch))
	m.HandleFunc("DELETE /api/artifacts/{id}", s.auth(s.handleDelete))
	m.HandleFunc("POST /api/artifacts/{id}/versions", s.auth(s.handleNewVersion))
	m.HandleFunc("POST /api/artifacts/{id}/versions/{n}/restore", s.auth(s.handleRestore))
	m.HandleFunc("POST /api/artifacts/{id}/shares", s.auth(s.handleShareCreate))
	m.HandleFunc("DELETE /api/artifacts/{id}/shares/{token}", s.auth(s.handleShareRevoke))
	m.HandleFunc("GET /api/artifacts/{id}/download/{path...}", s.auth(s.handleDownload))
	// MCP for agents.
	m.HandleFunc("POST /mcp", s.handleMCP)
	m.HandleFunc("GET /mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST")
		writeError(w, 405, "use POST (MCP streamable HTTP, JSON responses)")
	})
	// Public share page.
	m.HandleFunc("GET /s/{token}", s.handleSharePage)
	m.HandleFunc("POST /s/{token}", s.handleSharePage) // password-protected links
	m.HandleFunc("GET /s/{token}/g/{grant}/{path...}", s.handleShareGrant)
	// Artifact bytes (content origin).
	m.HandleFunc("GET /c/{vt}/{path...}", s.handleContent)
	m.HandleFunc("GET /s/{token}/f/{path...}", s.handleShareContent)
	s.mux = m
}

var contentPath = regexp.MustCompile(`^/(?:c/|s/[^/]+/[fg]/)`)

// ServeHTTP applies host separation, security headers and access logging.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: 200}
	h := rec.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Robots-Tag", "noindex, nofollow")
	isContent := contentPath.MatchString(r.URL.Path)
	if s.contHost != "" {
		host := strings.ToLower(r.Host)
		switch {
		case host == s.contHost && !isContent && r.URL.Path != "/health":
			http.Error(rec, "not found", 404)
			s.logRequest(r, rec, start)
			return
		case host != s.contHost && isContent:
			http.Error(rec, "not found", 404)
			s.logRequest(r, rec, start)
			return
		}
	}
	if !isContent {
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", s.appCSP("'none'"))
		if strings.HasPrefix(s.cfg.PublicURL, "https://") {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
	}
	s.mux.ServeHTTP(rec, r)
	s.logRequest(r, rec, start)
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }

var secretPath = regexp.MustCompile(`^/(c|s)/[^/]+|/shares/[^/]+|/g/[^/]+`)

// logRequest never records share or view tokens.
func (s *Server) logRequest(r *http.Request, rec *statusRecorder, start time.Time) {
	p := secretPath.ReplaceAllStringFunc(path.Clean("/"+r.URL.Path), func(m string) string {
		if strings.HasPrefix(m, "/shares/") {
			return "/shares/…"
		}
		if strings.HasPrefix(m, "/g/") {
			return "/g/…"
		}
		return m[:3] + "…"
	})
	log.Printf("%s %s %d %s", r.Method, p, rec.status, time.Since(start).Round(time.Millisecond))
}

// appCSP is the policy for app pages. Scripts need a per-response nonce,
// so files served from /c/ on a shared origin can never run as app code.
func (s *Server) appCSP(script string) string {
	return "default-src 'self'; script-src " + script + "; img-src 'self' data: blob: " + s.contentOrigin() +
		"; style-src 'self' 'unsafe-inline'; frame-src " + s.contentOrigin() + " 'self'; connect-src 'self'" +
		"; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'"
}

func (s *Server) contentOrigin() string {
	if s.cfg.ContentURL != "" {
		return s.cfg.ContentURL
	}
	return s.cfg.PublicURL
}

// ---------- theme and app shell ----------

// themeFile resolves a file from the theme directory, then the selected
// built-in theme, then the default theme.
func (s *Server) themeFile(name string) ([]byte, error) {
	if s.cfg.ThemeDir != "" {
		if b, err := os.ReadFile(filepath.Join(s.cfg.ThemeDir, filepath.Clean("/"+name))); err == nil {
			return b, nil
		}
	}
	for _, theme := range []string{s.cfg.Theme, "default"} {
		if b, err := fs.ReadFile(web.FS, "themes/"+theme+"/"+name); err == nil {
			return b, nil
		}
	}
	return nil, fs.ErrNotExist
}

// shellFile resolves app shell files (index.html, app.js, ...), which a
// theme directory may also override.
func (s *Server) shellFile(name string) ([]byte, error) {
	if s.cfg.ThemeDir != "" {
		if b, err := os.ReadFile(filepath.Join(s.cfg.ThemeDir, filepath.Clean("/"+name))); err == nil {
			return b, nil
		}
	}
	return fs.ReadFile(web.FS, name)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	raw, err := s.shellFile("index.html")
	if err != nil {
		writeError(w, 500, "index.html missing")
		return
	}
	tpl, err := template.New("index").Parse(string(raw))
	if err != nil {
		writeError(w, 500, "index.html: "+err.Error())
		return
	}
	nonce := b64.EncodeToString(randomBytes(16))
	var buf bytes.Buffer
	_ = tpl.Execute(&buf, map[string]any{"Name": s.cfg.Name, "Version": s.cfg.Version, "Nonce": nonce})
	w.Header().Set("Content-Security-Policy", s.appCSP("'nonce-"+nonce+"'"))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(buf.Bytes())
}

var assetName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

func (s *Server) handleAsset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !assetName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	var b []byte
	var err error
	switch name {
	case "app.js", "app.css":
		b, err = s.shellFile(name)
	default:
		b, err = s.themeFile(name)
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType(name))
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
}

func (s *Server) handleDesign(w http.ResponseWriter, r *http.Request) {
	b, err := s.themeFile("design.md")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleTemplate(w http.ResponseWriter, r *http.Request) {
	b, err := s.themeFile("template.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(b)
}

// ---------- helpers ----------

var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
	".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
	".pdf": "application/pdf", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
	".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wasm": "application/wasm",
	".xml": "application/xml", ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8", ".go": "text/plain; charset=utf-8",
	".sh": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".sql": "text/plain; charset=utf-8",
	".zip": "application/zip",
}

// contentType is decided by extension from a fixed table, never by the
// uploader (curl -F labels CSS/JS as octet-stream, which nosniff blocks)
// and never by the host's MIME database (which maps .shtml, .xht, .rss...
// to active content).
func contentType(name string) string {
	if t, ok := mimeTypes[strings.ToLower(path.Ext(name))]; ok {
		return t
	}
	return "application/octet-stream"
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(v); err != nil {
		return errors.New("invalid JSON body")
	}
	return nil
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	// Proxy headers are only believed when the connection itself comes from
	// the proxy (loopback or a private network such as a Docker bridge), so a
	// port accidentally left open to the Internet cannot spoof addresses.
	if s.cfg.TrustProxy == "" || !privatePeer(host) {
		return host
	}
	if s.cfg.TrustProxy == "cloudflare" {
		if ip := strings.TrimSpace(r.Header.Get("Cf-Connecting-Ip")); ip != "" {
			return ip
		}
	}
	// The rightmost entry was added by our proxy; anything left of it is
	// client-controlled. Tailscale Serve/Funnel overwrite the header with the
	// real client address.
	if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
		parts := strings.Split(xff[len(xff)-1], ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	if xr := r.Header.Get("X-Real-Ip"); xr != "" {
		return xr
	}
	return host
}

func privatePeer(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
