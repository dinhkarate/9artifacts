package app

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type env struct {
	t     *testing.T
	srv   *Server
	token string
}

func newEnv(t *testing.T, cfg Config) *env {
	t.Helper()
	st, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg.Version = "test"
	srv, err := New(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetPassword("correct horse battery"); err != nil {
		t.Fatal(err)
	}
	tok, _, err := st.CreateToken("test")
	if err != nil {
		t.Fatal(err)
	}
	return &env{t: t, srv: srv, token: tok}
}

// remoteAddr in a header map sets the connecting address instead of a header.
const remoteAddr = ":remote"

func (e *env) do(method, target string, body io.Reader, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	for k, v := range hdr {
		if k == remoteAddr {
			req.RemoteAddr = v
			continue
		}
		req.Header.Set(k, v)
	}
	if req.Host == "example.com" {
		req.Host = "localhost:8080"
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	return rec
}

func (e *env) api(method, path string, body any) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	return e.do(method, path, rd, map[string]string{"Authorization": "Bearer " + e.token, "Content-Type": "application/json"})
}

func (e *env) upload(path string, fields map[string]string, files map[string]string) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for name, content := range files {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", `form-data; name="files"; filename="`+name+`"`)
		h.Set("Content-Type", "application/octet-stream")
		w, _ := mw.CreatePart(h)
		_, _ = w.Write([]byte(content))
	}
	mw.Close()
	return e.do("POST", path, &buf, map[string]string{"Authorization": "Bearer " + e.token, "Content-Type": mw.FormDataContentType()})
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %d %q: %v", rec.Code, rec.Body.String(), err)
	}
	return v
}

func pathOf(u string) string {
	i := strings.Index(u, "://")
	j := strings.Index(u[i+3:], "/")
	return u[i+3+j:]
}

func TestPublishViewShareRevoke(t *testing.T) {
	e := newEnv(t, Config{PublicURL: "http://localhost:8080"})
	rec := e.upload("/api/artifacts", map[string]string{"tags": "Finance, q3"}, map[string]string{
		"index.html":      "<title>Q3 report</title><link rel=stylesheet href=assets/site.css>",
		"assets/site.css": "body{}",
		"assets/logo.png": "png",
	})
	if rec.Code != 201 {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	a := decode[artifactView](t, rec)
	if a.Title != "Q3 report" || a.Entry != "index.html" || len(a.Files) != 3 || strings.Join(a.Tags, ",") != "finance,q3" {
		t.Fatalf("unexpected artifact %+v", a)
	}

	// Entry HTML is sandboxed; CSS gets its real type even though the
	// upload said octet-stream.
	base := pathOf(a.ViewBase)
	rec = e.do("GET", base+"index.html", nil, nil)
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Security-Policy"), "sandbox allow-scripts") {
		t.Fatalf("html: %d csp=%q", rec.Code, rec.Header().Get("Content-Security-Policy"))
	}
	rec = e.do("GET", base+"assets/site.css", nil, nil)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/css; charset=utf-8" {
		t.Fatalf("css: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	// Tampered or foreign view tokens fail.
	parts := strings.Split(strings.Trim(base, "/"), "/")
	bad := "/c/" + parts[1][:len(parts[1])-2] + "xx/index.html"
	if rec = e.do("GET", bad, nil, nil); rec.Code != 404 {
		t.Fatalf("tampered token: %d", rec.Code)
	}
	if rec = e.do("GET", base+"..%2fvitrine.json", nil, nil); rec.Code == 200 {
		t.Fatal("path traversal served a file")
	}
	if rec = e.do("GET", base+"missing.html", nil, nil); rec.Code != 404 {
		t.Fatalf("missing file: %d", rec.Code)
	}

	// Shares must expire.
	if rec = e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]string{"ttl": "forever"}); rec.Code != 400 {
		t.Fatalf("bad ttl: %d", rec.Code)
	}
	rec = e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]string{"ttl": "24h", "note": "hello <b>"})
	sh := decode[shareView](t, rec)
	if rec.Code != 201 || time.Until(sh.ExpiresAt) > 25*time.Hour {
		t.Fatalf("share: %d %+v", rec.Code, sh)
	}
	page := e.do("GET", "/s/"+sh.Token, nil, nil)
	if page.Code != 200 || !strings.Contains(page.Body.String(), "hello &lt;b&gt;") || !strings.Contains(page.Body.String(), "/s/"+sh.Token+"/f/index.html") {
		t.Fatalf("share page: %d", page.Code)
	}
	if rec = e.do("GET", "/s/"+sh.Token+"/f/assets/site.css", nil, nil); rec.Code != 200 {
		t.Fatalf("share asset: %d", rec.Code)
	}
	if rec = e.api("DELETE", "/api/artifacts/"+a.ID+"/shares/"+sh.Token, nil); rec.Code != 200 {
		t.Fatalf("revoke: %d", rec.Code)
	}
	for _, p := range []string{"/s/" + sh.Token, "/s/" + sh.Token + "/f/index.html"} {
		if rec = e.do("GET", p, nil, nil); rec.Code != 410 {
			t.Fatalf("%s after revoke: %d", p, rec.Code)
		}
	}
	if rec = e.do("GET", "/s/nope", nil, nil); rec.Code != 404 {
		t.Fatalf("unknown share: %d", rec.Code)
	}

	// New version with keep carries over unchanged files.
	rec = e.upload("/api/artifacts/"+a.ID+"/versions", map[string]string{"keep": "1", "message": "tweak"}, map[string]string{"index.html": "<title>Q3 report v2</title>"})
	v2 := decode[artifactView](t, rec)
	if rec.Code != 201 || v2.Version != 2 || len(v2.Files) != 3 || v2.Title != "Q3 report" {
		t.Fatalf("v2: %d %+v", rec.Code, v2)
	}
	rec = e.upload("/api/artifacts/"+a.ID+"/versions", nil, map[string]string{"index.html": "x"})
	if v3 := decode[artifactView](t, rec); len(v3.Files) != 1 || len(v3.Versions) != 3 {
		t.Fatalf("v3 replace: %+v", v3)
	}

	// Delete removes everything.
	if rec = e.api("DELETE", "/api/artifacts/"+a.ID, nil); rec.Code != 200 {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec = e.do("GET", base+"index.html", nil, nil); rec.Code != 404 {
		t.Fatalf("content after delete: %d", rec.Code)
	}
}

func TestAuth(t *testing.T) {
	e := newEnv(t, Config{})
	if rec := e.do("GET", "/api/artifacts", nil, nil); rec.Code != 401 {
		t.Fatalf("anonymous list: %d", rec.Code)
	}
	if rec := e.do("GET", "/api/artifacts", nil, map[string]string{"Authorization": "Bearer vt_wrong"}); rec.Code != 401 {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	login := func(pw string) *httptest.ResponseRecorder {
		return e.do("POST", "/api/auth/login", strings.NewReader(`{"password":"`+pw+`"}`), map[string]string{"Content-Type": "application/json"})
	}
	rec := login("correct horse battery")
	if rec.Code != 200 {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	cookie := rec.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie flags: %+v", cookie)
	}
	ck := cookie.Name + "=" + cookie.Value
	if rec := e.do("GET", "/api/artifacts", nil, map[string]string{"Cookie": ck}); rec.Code != 200 {
		t.Fatalf("session list: %d", rec.Code)
	}
	// Cookie-authenticated writes need the X-Vitrine header (CSRF).
	if rec := e.do("POST", "/api/tokens", strings.NewReader(`{"name":"x"}`), map[string]string{"Cookie": ck, "Content-Type": "application/json"}); rec.Code != 401 {
		t.Fatalf("csrf: %d", rec.Code)
	}
	if rec := e.do("POST", "/api/tokens", strings.NewReader(`{"name":"x"}`), map[string]string{"Cookie": ck, "Content-Type": "application/json", "X-Vitrine": "1"}); rec.Code != 201 {
		t.Fatalf("token create: %d", rec.Code)
	}
	// API tokens cannot manage tokens.
	if rec := e.api("POST", "/api/tokens", map[string]string{"name": "x"}); rec.Code != 401 {
		t.Fatalf("token minting with token: %d", rec.Code)
	}
	// Lockout after repeated failures.
	var last int
	for range 6 {
		last = login("nope").Code
	}
	if last != 429 {
		t.Fatalf("lockout: %d", last)
	}
	if rec := login("correct horse battery"); rec.Code != 429 {
		t.Fatalf("locked login allowed: %d", rec.Code)
	}
	// Logout kills the session.
	e.do("POST", "/api/auth/logout", nil, map[string]string{"Cookie": ck})
	if rec := e.do("GET", "/api/artifacts", nil, map[string]string{"Cookie": ck}); rec.Code != 401 {
		t.Fatalf("after logout: %d", rec.Code)
	}
}

func TestSetupCode(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	srv, err := New(Config{}, st)
	if err != nil {
		t.Fatal(err)
	}
	if srv.SetupURL() == "" {
		t.Fatal("no setup URL on first run")
	}
	post := func(body string) int {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/auth/setup", strings.NewReader(body)))
		return rec.Code
	}
	if c := post(`{"code":"wrong","password":"long enough pw"}`); c != 403 {
		t.Fatalf("wrong code: %d", c)
	}
	code := strings.TrimPrefix(srv.SetupURL(), "http://localhost:8080/setup#code=")
	if c := post(`{"code":"` + code + `","password":"short"}`); c != 400 {
		t.Fatalf("short password: %d", c)
	}
	if c := post(`{"code":"` + code + `","password":"long enough pw"}`); c != 201 {
		t.Fatalf("setup: %d", c)
	}
	if c := post(`{"code":"` + code + `","password":"long enough pw"}`); c != 409 {
		t.Fatalf("second setup: %d", c)
	}
}

func TestContentOriginSeparation(t *testing.T) {
	e := newEnv(t, Config{PublicURL: "https://art.example.com", ContentURL: "https://usercontent.example.net"})
	rec := e.upload("/api/artifacts", nil, map[string]string{"page.html": "<p>x"})
	req := func(host, path string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = host
		r.Header.Set("Authorization", "Bearer "+e.token)
		w := httptest.NewRecorder()
		e.srv.ServeHTTP(w, r)
		return w.Code
	}
	a := decode[artifactView](t, rec)
	if !strings.HasPrefix(a.ViewBase, "https://usercontent.example.net/c/") {
		t.Fatalf("viewBase on wrong origin: %s", a.ViewBase)
	}
	p := pathOf(a.ViewBase) + "page.html"
	if c := req("usercontent.example.net", p); c != 200 {
		t.Fatalf("content host: %d", c)
	}
	if c := req("art.example.com", p); c != 404 {
		t.Fatalf("content served on app host: %d", c)
	}
	if c := req("usercontent.example.net", "/api/artifacts"); c != 404 {
		t.Fatalf("API served on content host: %d", c)
	}
	if _, err := New(Config{PublicURL: "https://a.example.com", ContentURL: "https://a.example.com"}, e.srv.store); err == nil {
		t.Fatal("same content and public host accepted")
	}
}

func TestMCP(t *testing.T) {
	e := newEnv(t, Config{})
	call := func(body string) map[string]any {
		rec := e.do("POST", "/mcp", strings.NewReader(body), map[string]string{"Authorization": "Bearer " + e.token, "Content-Type": "application/json"})
		if rec.Code == 202 {
			return nil
		}
		return decode[map[string]any](t, rec)
	}
	init := call(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	if init["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize: %v", init)
	}
	if call(`{"jsonrpc":"2.0","method":"notifications/initialized"}`) != nil {
		t.Fatal("notification got a response")
	}
	pub := call(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"publish_artifact","arguments":{"title":"Hi","files":[{"name":"index.html","content":"<h1>hi</h1>"},{"name":"a.css","content":"Ym9keXt9","encoding":"base64"}]}}}`)
	text := pub["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "version 1") {
		t.Fatalf("publish: %s", text)
	}
	id := strings.Fields(strings.Split(text, "(id ")[1])[0]
	id = strings.TrimSuffix(id, ",")
	upd := call(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"publish_artifact","arguments":{"id":"` + id + `","files":[{"name":"index.html","content":"<h1>v2</h1>"}]}}}`)
	if !strings.Contains(upd["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string), "version 2") {
		t.Fatalf("update: %v", upd)
	}
	read := call(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_artifact","arguments":{"id":"` + id + `"}}}`)
	got := read["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(got, "<h1>v2</h1>") || !strings.Contains(got, "a.css") {
		t.Fatalf("read after keep-update: %s", got)
	}
	bad := call(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"share_artifact","arguments":{"id":"` + id + `","ttl":"99d"}}}`)
	if bad["result"].(map[string]any)["isError"] != true {
		t.Fatalf("bad ttl not an error: %v", bad)
	}
	if rec := e.do("POST", "/mcp", strings.NewReader(`{}`), nil); rec.Code != 401 {
		t.Fatalf("mcp without token: %d", rec.Code)
	}
}

func TestCleanName(t *testing.T) {
	for _, ok := range []string{"index.html", "assets/a b.png", "x/y/z.css", "report (1).pdf"} {
		if _, err := cleanName(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "../x", "a/../../b", ".env", "a/.git/config", "/etc/passwd", "a//b", "a\x00b"} {
		if _, err := cleanName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestLogRedaction(t *testing.T) {
	var buf bytes.Buffer
	e := newEnv(t, Config{})
	r := httptest.NewRequest("DELETE", "/api/artifacts/abc/shares/SECRETTOKEN", nil)
	rec := &statusRecorder{ResponseWriter: httptest.NewRecorder(), status: 200}
	logTo(&buf, func() { e.srv.logRequest(r, rec, time.Now()) })
	r2 := httptest.NewRequest("GET", "/s/SECRETTOKEN/f/index.html", nil)
	logTo(&buf, func() { e.srv.logRequest(r2, rec, time.Now()) })
	if strings.Contains(buf.String(), "SECRETTOKEN") {
		t.Fatalf("token leaked to log: %s", buf.String())
	}
}

func logTo(w io.Writer, fn func()) {
	old := log.Writer()
	log.SetOutput(w)
	defer log.SetOutput(old)
	fn()
}

// Regression: extensions the host MIME database maps to active content
// must never be served unsandboxed.
func TestEverythingButPDFIsSandboxed(t *testing.T) {
	e := newEnv(t, Config{})
	rec := e.upload("/api/artifacts", nil, map[string]string{
		"index.html": "x", "evil.shtml": "<script>1</script>", "a.xht": "x", "b.svgz": "x", "c.rss": "x",
		"d.png": "x", "e.css": "x", "f.pdf": "%PDF",
	})
	a := decode[artifactView](t, rec)
	base := pathOf(a.ViewBase)
	for _, f := range []string{"index.html", "evil.shtml", "a.xht", "b.svgz", "c.rss", "d.png", "e.css"} {
		r := e.do("GET", base+f, nil, nil)
		if !strings.HasPrefix(r.Header().Get("Content-Security-Policy"), "sandbox") {
			t.Errorf("%s served without sandbox (type %q)", f, r.Header().Get("Content-Type"))
		}
	}
	for _, f := range []string{"evil.shtml", "a.xht", "c.rss"} {
		if ct := e.do("GET", base+f, nil, nil).Header().Get("Content-Type"); ct != "application/octet-stream" {
			t.Errorf("%s: content type %q", f, ct)
		}
	}
	if r := e.do("GET", base+"f.pdf", nil, nil); r.Header().Get("Content-Type") != "application/pdf" {
		t.Errorf("pdf type %q", r.Header().Get("Content-Type"))
	}
}

func TestTrustProxyUsesRightmostAddress(t *testing.T) {
	e := newEnv(t, Config{TrustProxy: "xff"})
	login := func(xff string) int {
		return e.do("POST", "/api/auth/login", strings.NewReader(`{"password":"wrong password"}`),
			map[string]string{"Content-Type": "application/json", "X-Forwarded-For": xff, remoteAddr: "127.0.0.1:5000"}).Code
	}
	var last int
	for i := range 6 {
		last = login("10.9.9." + string(rune('0'+i)) + ", 203.0.113.7")
	}
	if last != 429 {
		t.Fatalf("spoofed left-most XFF bypassed lockout: %d", last)
	}
}

func TestTrustProxyModes(t *testing.T) {
	ip := func(mode, remote string, hdr map[string]string) string {
		e := newEnv(t, Config{TrustProxy: mode})
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = remote
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		return e.srv.clientIP(req)
	}
	cf := map[string]string{"CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "198.51.100.1, 203.0.113.8"}
	cases := []struct{ name, mode, remote, want string }{
		{"off ignores headers", "", "127.0.0.1:1", "127.0.0.1"},
		{"cloudflare uses CF-Connecting-IP", "cloudflare", "127.0.0.1:1", "203.0.113.9"},
		{"xff uses rightmost entry", "true", "10.0.0.5:1", "203.0.113.8"},
		{"tailscale uses rightmost entry", "tailscale", "[::1]:1", "203.0.113.8"},
		{"public peer is not trusted", "cloudflare", "198.51.100.77:1", "198.51.100.77"},
	}
	for _, c := range cases {
		if got := ip(c.mode, c.remote, cf); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
	st, _ := OpenStore(t.TempDir())
	if _, err := New(Config{TrustProxy: "nginx"}, st); err == nil {
		t.Error("unknown trust-proxy mode accepted")
	}
}

func TestGlobalPasswordCap(t *testing.T) {
	e := newEnv(t, Config{TrustProxy: "xff"})
	var last int
	for i := range globalFailLimit + 1 {
		last = e.do("POST", "/api/auth/login", strings.NewReader(`{"password":"nope"}`),
			map[string]string{"Content-Type": "application/json", "X-Forwarded-For": "198.51.100." + strconv.Itoa(i), remoteAddr: "172.18.0.2:5000"}).Code
	}
	if last != 429 {
		t.Fatalf("distributed guessing not capped: %d", last)
	}
}

func TestChallengeFloodDoesNotBlockLogin(t *testing.T) {
	e := newEnv(t, Config{})
	for range 1100 {
		e.srv.newChallenge("login")
	}
	id, _ := e.srv.newChallenge("login")
	if _, ok := e.srv.takeChallenge(id, "login"); !ok {
		t.Fatal("fresh challenge dropped after flood")
	}
	limited := false
	for range 25 {
		if e.do("POST", "/api/auth/passkey/login/begin", strings.NewReader("{}"), nil).Code == 429 {
			limited = true
		}
	}
	if !limited {
		t.Fatal("passkey begin not rate limited")
	}
}

func TestSharesPinVersionAndHTTPSCookie(t *testing.T) {
	e := newEnv(t, Config{PublicURL: "https://art.example.com"})
	a := decode[artifactView](t, e.upload("/api/artifacts", nil, map[string]string{"index.html": "v1 secret-free"}))
	sh := decode[shareView](t, e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]string{"ttl": "1h"}))
	if sh.Version != 1 {
		t.Fatalf("share not pinned: %+v", sh)
	}
	e.upload("/api/artifacts/"+a.ID+"/versions", nil, map[string]string{"index.html": "v2 private draft"})
	if body := e.do("GET", "/s/"+sh.Token+"/f/index.html", nil, nil).Body.String(); body != "v1 secret-free" {
		t.Fatalf("share exposed a later version: %q", body)
	}
	rec := e.do("POST", "/api/auth/login", strings.NewReader(`{"password":"correct horse battery"}`), map[string]string{"Content-Type": "application/json"})
	if c := rec.Result().Cookies()[0]; c.Name != "__Host-vitrine_session" || !c.Secure {
		t.Fatalf("cookie: %+v", c)
	}
	idx := e.do("GET", "/", nil, nil)
	csp := idx.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'nonce-") || !strings.Contains(idx.Body.String(), `nonce="`) {
		t.Fatalf("index CSP without nonce: %s", csp)
	}
	if !strings.Contains(e.do("GET", "/settings", nil, nil).Header().Get("Content-Security-Policy"), "'nonce-") {
		t.Fatal("settings shell lacks nonce")
	}
	if !strings.Contains(e.do("GET", "/api/me", nil, nil).Header().Get("Content-Security-Policy"), "script-src 'none'") {
		t.Fatal("non-shell pages allow scripts")
	}
}

func TestMain(m *testing.M) {
	pbkdf2Iter = 1000
	os.Exit(m.Run())
}

func TestUploadOverLimitIs413(t *testing.T) {
	e := newEnv(t, Config{MaxUpload: 1 << 20})
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("files", "big.html")
	fw.Write(bytes.Repeat([]byte("a"), 2<<20))
	mw.Close()
	hdr := map[string]string{"Authorization": "Bearer " + e.token, "Content-Type": mw.FormDataContentType()}
	rec := e.do("POST", "/api/artifacts", &buf, hdr)
	if rec.Code != 413 || !strings.Contains(rec.Body.String(), "max-upload-mb") {
		t.Fatalf("oversized upload: %d %s", rec.Code, rec.Body)
	}
}

func TestRestoreVersion(t *testing.T) {
	e := newEnv(t, Config{})
	a := decode[artifactView](t, e.upload("/api/artifacts", nil, map[string]string{"index.html": "<h1>one</h1>", "data.json": "{}"}))
	e.upload("/api/artifacts/"+a.ID+"/versions", nil, map[string]string{"index.html": "<h1>two</h1>"})
	rec := e.api("POST", "/api/artifacts/"+a.ID+"/versions/1/restore", nil)
	got := decode[artifactView](t, rec)
	if rec.Code != 201 || got.Version != 3 || len(got.Files) != 2 {
		t.Fatalf("restore: %d v%d files=%d", rec.Code, got.Version, len(got.Files))
	}
	b, err := os.ReadFile(filepath.Join(e.srv.store.VersionDir(a.ID, 3), "index.html"))
	if err != nil || string(b) != "<h1>one</h1>" {
		t.Fatalf("restored content: %q %v", b, err)
	}
	if rec := e.api("POST", "/api/artifacts/"+a.ID+"/versions/9/restore", nil); rec.Code != 404 {
		t.Fatalf("missing version: %d", rec.Code)
	}
}

func TestShareViewLimit(t *testing.T) {
	e := newEnv(t, Config{})
	a := decode[artifactView](t, e.upload("/api/artifacts", nil, map[string]string{"index.html": "<h1>hi</h1>"}))
	sh := decode[shareView](t, e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]any{"ttl": "1h", "maxViews": 1}))
	from := func(path, ip string) int {
		return e.do("GET", path, nil, map[string]string{remoteAddr: ip + ":4000"}).Code
	}
	page, file := "/s/"+sh.Token, "/s/"+sh.Token+"/f/index.html"
	for _, p := range []string{page, file, page} {
		if c := from(p, "198.51.100.10"); c != 200 {
			t.Fatalf("first visitor %s: %d", p, c)
		}
	}
	if c := from(file, "198.51.100.11"); c != 410 {
		t.Fatalf("second visitor got %d, want 410", c)
	}
	got := decode[artifactView](t, e.api("GET", "/api/artifacts/"+a.ID, nil))
	if s := got.Shares[0]; s.Views != 1 || s.Active || s.LastView == nil {
		t.Fatalf("share after limit: views=%d active=%v last=%v", s.Views, s.Active, s.LastView)
	}
	if rec := e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]any{"ttl": "1h", "maxViews": -1}); rec.Code != 400 {
		t.Fatalf("negative maxViews: %d", rec.Code)
	}
}

func TestWebhooks(t *testing.T) {
	type hit struct{ body, title, ctype string }
	got := make(chan hit, 16)
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- hit{string(b), r.Header.Get("Title"), r.Header.Get("Content-Type")}
	}))
	defer hook.Close()
	e := newEnv(t, Config{Webhooks: []string{hook.URL + "/json", "ntfy+" + hook.URL + "/topic"}})
	a := decode[artifactView](t, e.upload("/api/artifacts", map[string]string{"title": "Q3 report"}, map[string]string{"index.html": "x"}))
	e.upload("/api/artifacts/"+a.ID+"/versions", map[string]string{"message": "fix chart"}, map[string]string{"index.html": "y"})
	sh := decode[shareView](t, e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]any{"ttl": "1h"}))
	e.do("GET", "/s/"+sh.Token, nil, nil)
	events := map[string]bool{}
	for range 8 {
		select {
		case h := <-got:
			if strings.Contains(h.body, sh.Token) {
				t.Fatalf("share token leaked to webhook: %s", h.body)
			}
			if h.title != "" {
				if strings.HasPrefix(h.body, "{") || h.ctype == "application/json" {
					t.Fatalf("ntfy hook got JSON: %q", h.body)
				}
				continue
			}
			var ev event
			if err := json.Unmarshal([]byte(h.body), &ev); err != nil || ev.Text == "" || ev.Artifact.ID != a.ID {
				t.Fatalf("bad event %q: %v", h.body, err)
			}
			events[ev.Event] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("missing webhooks, got %v", events)
		}
	}
	for _, k := range []string{EventPublished, EventVersion, EventShared, EventShareVisit} {
		if !events[k] {
			t.Errorf("no %s event", k)
		}
	}
	st, _ := OpenStore(t.TempDir())
	if _, err := New(Config{Webhooks: []string{"ftp://x"}}, st); err == nil {
		t.Error("non-HTTP webhook accepted")
	}
}

func TestSharePageLinkPreview(t *testing.T) {
	e := newEnv(t, Config{})
	a := decode[artifactView](t, e.upload("/api/artifacts", map[string]string{"title": `Q3 "draft" <report>`}, map[string]string{"index.html": "x"}))
	sh := decode[shareView](t, e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]any{"ttl": "1h", "note": "For the board"}))
	body := e.do("GET", "/s/"+sh.Token, nil, nil).Body.String()
	for _, want := range []string{`og:title" content="Q3 &#34;draft&#34; &lt;report&gt;"`, `og:description" content="For the board"`} {
		if !strings.Contains(body, want) {
			t.Errorf("share page missing %s", want)
		}
	}
}

func TestPreviewBotDoesNotUseAView(t *testing.T) {
	e := newEnv(t, Config{})
	a := decode[artifactView](t, e.upload("/api/artifacts", nil, map[string]string{"index.html": "x"}))
	sh := decode[shareView](t, e.api("POST", "/api/artifacts/"+a.ID+"/shares", map[string]any{"ttl": "1h", "maxViews": 1}))
	bot := map[string]string{"User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", remoteAddr: "203.0.113.50:1"}
	if c := e.do("GET", "/s/"+sh.Token, nil, bot).Code; c != 200 {
		t.Fatalf("bot preview: %d", c)
	}
	if c := e.do("GET", "/s/"+sh.Token+"/f/index.html", nil, map[string]string{remoteAddr: "198.51.100.20:1"}).Code; c != 200 {
		t.Fatalf("real visitor after bot preview: %d", c)
	}
	if c := e.do("GET", "/s/"+sh.Token+"/f/index.html", nil, bot).Code; c != 410 {
		t.Fatalf("spoofed bot reading content past the limit: %d", c)
	}
}
