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

func (e *env) do(method, target string, body io.Reader, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	for k, v := range hdr {
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
