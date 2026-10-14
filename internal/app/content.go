package app

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dinhkarate/9artifacts/internal/markdown"
)

// View tokens let sandboxed iframes (which run on an opaque origin and so
// never carry the session cookie) fetch an artifact's sibling files. A
// token is scoped to one artifact version and expires after viewTTL.
// Expiry is rounded up to the hour so URLs stay cacheable.

func (s *Server) sign(payload string) string {
	m := hmac.New(sha256.New, s.signKey)
	m.Write([]byte("view|" + payload))
	return b64.EncodeToString(m.Sum(nil)[:18])
}

func (s *Server) viewToken(id string, n int) string {
	exp := time.Now().Add(viewTTL).Truncate(time.Hour).Add(time.Hour).Unix()
	payload := id + "." + strconv.Itoa(n) + "." + strconv.FormatInt(exp, 36)
	return payload + "." + s.sign(payload)
}

func (s *Server) viewBase(id string, n int) string {
	return s.contentOrigin() + "/c/" + s.viewToken(id, n) + "/"
}

func (s *Server) checkViewToken(tok string) (id string, n int, err error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 4 {
		return "", 0, errors.New("bad token")
	}
	payload := strings.Join(parts[:3], ".")
	if subtle.ConstantTimeCompare([]byte(s.sign(payload)), []byte(parts[3])) != 1 {
		return "", 0, errors.New("bad token")
	}
	exp, err := strconv.ParseInt(parts[2], 36, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", 0, errors.New("expired token")
	}
	n, err = strconv.Atoi(parts[1])
	if err != nil {
		return "", 0, errors.New("bad token")
	}
	return parts[0], n, nil
}

func (s *Server) handleContent(w http.ResponseWriter, r *http.Request) {
	id, n, err := s.checkViewToken(r.PathValue("vt"))
	if err != nil {
		http.Error(w, "link expired, reload the page", 404)
		return
	}
	var v *Version
	s.store.Read(func(st *State) {
		if a := st.Artifacts[id]; a != nil {
			if x := a.Version(n); x != nil {
				c := *x
				v = &c
			}
		}
	})
	if v == nil {
		http.NotFound(w, r)
		return
	}
	s.serveVersionFile(w, r, id, v, r.PathValue("path"), r.URL.Query().Has("download"), r.URL.Query().Has("view"), r.URL.Query().Has("vc"))
}

func (s *Server) handleShareContent(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	id, v, sh, title, status := s.resolveShare(token)
	if status == 200 && sh.PasswordHash != "" {
		// Protected links serve files only through a grant from the unlock form.
		status = http.StatusUnauthorized
	}
	if status == 200 && !s.recordVisit(r, token, id, title, v, sh) {
		status = 410
	}
	if status != 200 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	s.serveVersionFile(w, r, id, v, r.PathValue("path"), r.URL.Query().Has("download"), r.URL.Query().Has("view"), false)
}

// handleShareGrant serves the files of a password-protected link to a visitor
// who unlocked it. The grant is signed for this token and short-lived, and the
// link is re-checked on every request, so revoking still takes effect at once.
func (s *Server) handleShareGrant(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	id, v, _, _, status := s.resolveShare(token)
	if status == 200 && !s.checkGrant(token, r.PathValue("grant")) {
		status = http.StatusUnauthorized
	}
	if status != 200 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	s.serveVersionFile(w, r, id, v, r.PathValue("path"), r.URL.Query().Has("download"), r.URL.Query().Has("view"), false)
}

const (
	grantTTL    = 2 * time.Hour
	shareCookie = "9artifacts_share" // unlock grant for one password-protected link
)

func (s *Server) grant(token string) string {
	exp := strconv.FormatInt(time.Now().Add(grantTTL).Unix(), 36)
	return exp + "." + s.sign("share|"+token+"|"+exp)
}

func (s *Server) checkGrant(token, g string) bool {
	exp, sig, ok := strings.Cut(g, ".")
	if !ok || subtle.ConstantTimeCompare([]byte(s.sign("share|"+token+"|"+exp)), []byte(sig)) != 1 {
		return false
	}
	t, err := strconv.ParseInt(exp, 36, 64)
	return err == nil && time.Now().Unix() <= t
}

// resolveShare returns the artifact id, version and title for a live share
// token, or 404/410.
func (s *Server) resolveShare(token string) (id string, v *Version, sh Share, title string, status int) {
	status = 404
	s.store.Read(func(st *State) {
		a, share := st.FindShare(token)
		if a == nil {
			return
		}
		sh = *share
		if !share.Live(time.Now()) {
			status = 410
			return
		}
		if x := a.Version(share.Version); x != nil {
			c := *x
			id, v, title, status = a.ID, &c, a.Title, 200
		}
	})
	return id, v, sh, title, status
}

// recordVisit counts the visitor (see countView) and tells the webhooks about
// new ones. It returns false when the link has no views left for them.
func (s *Server) recordVisit(r *http.Request, token, id, title string, v *Version, sh Share) bool {
	ok, first := s.countView(token, s.clientIP(r))
	if first {
		detail := fmt.Sprintf("visitor %d", sh.Views+1)
		if sh.MaxViews > 0 {
			detail += fmt.Sprintf(" of %d", sh.MaxViews)
		}
		s.notify(EventShareVisit, eventItem{ID: id, Title: title, URL: s.cfg.PublicURL + "/a/" + id, Version: v.N}, detail)
	}
	return ok
}

// isPreviewBot matches the crawlers chat and social apps send to unfurl links.
func isPreviewBot(ua string) bool {
	ua = strings.ToLower(ua)
	for _, bot := range []string{"slackbot", "discordbot", "facebookexternalhit", "twitterbot", "telegrambot",
		"whatsapp", "linkedinbot", "skypeuripreview", "zalo", "mattermost", "redditbot", "embedly", "iframely"} {
		if strings.Contains(ua, bot) {
			return true
		}
	}
	return false
}

const maxViewers = 10000

// countView counts each visitor (client address) once. On links with a view
// limit the visitor is remembered for the link's lifetime, so people who were
// counted can always come back; elsewhere a visit counts once per hour. ok is
// false when the link has no views left for this visitor; first is true when
// this request was counted as a new visit.
func (s *Server) countView(token, ip string) (ok, first bool) {
	key := token + "|" + ip
	visitor := s.sign("visitor|" + key)
	now := time.Now()
	var limited, known bool
	s.store.Read(func(st *State) {
		if _, sh := st.FindShare(token); sh != nil {
			limited, known = sh.MaxViews > 0, slices.Contains(sh.Visitors, visitor)
		}
	})
	if known {
		return true, false
	}
	if !limited {
		s.mu.Lock()
		seen, recent := s.viewers[key]
		s.mu.Unlock()
		if recent && now.Sub(seen) < time.Hour {
			return true, false
		}
	}
	err := s.store.Update(func(st *State) error {
		_, sh := st.FindShare(token)
		if sh != nil && slices.Contains(sh.Visitors, visitor) {
			return errCounted
		}
		if sh == nil || !sh.Active(now) {
			return errViewLimit
		}
		if sh.MaxViews > 0 {
			sh.Visitors = append(sh.Visitors, visitor)
		}
		sh.Views++
		t := now.UTC()
		sh.LastViewedAt = &t
		return nil
	})
	if errors.Is(err, errCounted) {
		return true, false
	}
	if err != nil {
		return false, false
	}
	if !limited {
		s.mu.Lock()
		if len(s.viewers) >= maxViewers {
			for k, t := range s.viewers {
				if now.Sub(t) >= time.Hour {
					delete(s.viewers, k)
				}
			}
			if len(s.viewers) >= maxViewers {
				clear(s.viewers)
			}
		}
		s.viewers[key] = now
		s.mu.Unlock()
	}
	return true, true
}

var errCounted = errors.New("visitor already counted")

var errViewLimit = errors.New("share link is no longer available")

// needsSandbox: every artifact response is sandboxed except PDFs, which
// browsers refuse to render in a sandboxed document. Sandboxing images, CSS
// or text costs nothing, and it fails safe for any type we got wrong.
func needsSandbox(name string) bool {
	return strings.ToLower(path.Ext(name)) != ".pdf"
}

func (s *Server) contentHeaders(w http.ResponseWriter, sandbox bool) {
	h := w.Header()
	ancestors := "frame-ancestors " + s.cfg.PublicURL + " 'self'"
	if sandbox {
		csp := "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads; " + ancestors
		if s.cfg.ArtifactCSP != "" {
			csp += "; " + s.cfg.ArtifactCSP
		}
		h.Set("Content-Security-Policy", csp)
	} else {
		h.Set("Content-Security-Policy", ancestors)
	}
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
	h.Set("Cache-Control", "private, max-age=3600")
}

// serveVersionFile writes one file of a version. With pick (the owner's
// viewer only), HTML gets a tiny script that reports the selected text to the
// viewer, so comments can quote it; downloads and share links are untouched.
func (s *Server) serveVersionFile(w http.ResponseWriter, r *http.Request, id string, v *Version, name string, download, render, pick bool) {
	if name == "" {
		name = v.Entry
	}
	name, err := cleanName(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	known := false
	for _, f := range v.Files {
		if f.Name == name {
			known = true
		}
	}
	if !known {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(s.store.VersionDir(id, v.N))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	f, err := root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if download {
		w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(path.Base(name), `"`, "")+`"`)
		w.Header().Set("Content-Type", "application/octet-stream")
		s.contentHeaders(w, true)
		http.ServeContent(w, r, "", st.ModTime(), f)
		return
	}
	if render && strings.HasSuffix(strings.ToLower(name), ".md") {
		raw, err := io.ReadAll(io.LimitReader(f, 8<<20))
		if err != nil {
			http.Error(w, "read error", 500)
			return
		}
		s.contentHeaders(w, true)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		page := s.markdownPage(path.Base(name), string(raw))
		if pick {
			page = append(page, s.pickScript()...)
		}
		_, _ = w.Write(page)
		return
	}
	if pick && strings.HasPrefix(contentType(name), "text/html") && st.Size() < 16<<20 {
		raw, err := io.ReadAll(f)
		if err != nil {
			http.Error(w, "read error", 500)
			return
		}
		s.contentHeaders(w, true)
		w.Header().Set("Content-Type", contentType(name))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(append(raw, s.pickScript()...))
		return
	}
	s.contentHeaders(w, needsSandbox(name))
	w.Header().Set("Content-Type", contentType(name))
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// pickScript posts the current text selection to the 9artifacts viewer. Appended
// after </html> it still runs: browsers move trailing content into <body>.
func (s *Server) pickScript() []byte {
	origin, _ := json.Marshal(s.cfg.PublicURL)
	return []byte(`<script>(()=>{let t,last="";document.addEventListener("selectionchange",()=>{clearTimeout(t);t=setTimeout(()=>{const s=String(getSelection()||"").trim().slice(0,500);if(s!==last){last=s;parent.postMessage({artifacts:"selection",text:s},` + string(origin) + `)}},300)})})()</script>`)
}

func (s *Server) markdownPage(title, src string) []byte {
	css, _ := s.themeFile("markdown.css")
	var b bytes.Buffer
	b.WriteString(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>`)
	template.HTMLEscape(&b, []byte(title))
	b.WriteString(`</title><style>`)
	b.Write(css)
	b.WriteString(`</style></head><body><main class="markdown">`)
	b.WriteString(markdown.Render(src))
	b.WriteString(`</main></body></html>`)
	return b.Bytes()
}

// ---------- public share page ----------

func fileKind(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm":
		return "html"
	case ".md":
		return "markdown"
	case ".pdf":
		return "pdf"
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg":
		return "image"
	case ".txt", ".csv", ".json", ".log", ".yaml", ".yml", ".xml", ".py", ".go", ".js", ".ts", ".sh", ".sql", ".css":
		return "text"
	}
	return "file"
}

func (s *Server) handleSharePage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	id, v, sh, title, status := s.resolveShare(token)
	data := map[string]any{"Name": s.cfg.Name, "Version": s.cfg.Version}
	base := s.contentOrigin() + "/s/" + token + "/f/"
	switch {
	case status != 200:
	case sh.PasswordHash != "":
		// Nothing about the artifact (not even its title) is shown until the
		// password is right; a wrong guess costs a login-style failure.
		ip := "share|" + s.clientIP(r)
		status = http.StatusUnauthorized
		if c, err := r.Cookie(shareCookie); err == nil && r.Method == http.MethodGet && s.checkGrant(token, c.Value) {
			status = 200
			base = s.contentOrigin() + "/s/" + token + "/g/" + c.Value + "/"
			if !s.recordVisit(r, token, id, title, v, sh) {
				status = 410
			}
			break
		}
		if r.Method != http.MethodPost {
			break
		}
		if d := s.locked(ip); d > 0 {
			data["Error"] = fmt.Sprintf("Too many attempts. Try again in %d minutes.", int(d.Minutes())+1)
			status = http.StatusTooManyRequests
			break
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if !checkPassword(r.PostFormValue("password"), sh.PasswordHash) {
			s.fail(ip)
			data["Error"] = "Wrong password."
			break
		}
		if !s.recordVisit(r, token, id, title, v, sh) {
			status = 410
			break
		}
		// Remember the unlock for this link only, then redirect so a reload
		// is a plain GET instead of a form resubmission.
		http.SetCookie(w, &http.Cookie{Name: shareCookie, Value: s.grant(token), Path: "/s/" + token, MaxAge: int(grantTTL.Seconds()),
			HttpOnly: true, Secure: strings.HasPrefix(s.cfg.PublicURL, "https://"), SameSite: http.SameSiteLaxMode})
		http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
		return
	case r.Method == http.MethodPost:
		status = http.StatusMethodNotAllowed
	case !isPreviewBot(r.UserAgent()):
		// Chat apps fetch the page to build a link preview; that must not use
		// up a view. Only the page shell (title, note, file names) is exempt:
		// files are always counted, so a spoofed User-Agent gains nothing.
		if !s.recordVisit(r, token, id, title, v, sh) {
			status = 410
		}
	}
	data["Status"] = status
	if status == 200 {
		src := base + v.Entry
		if fileKind(v.Entry) == "markdown" {
			src += "?view=1"
		}
		type fileLink struct {
			Name, Href string
			Size       int64
		}
		var files []fileLink
		for _, f := range v.Files {
			files = append(files, fileLink{Name: f.Name, Href: base + f.Name + "?download=1", Size: f.Size})
		}
		data["Title"] = title
		data["Note"] = sh.Note
		data["Kind"] = fileKind(v.Entry)
		data["Src"] = src
		data["Files"] = files
		data["Expires"] = sh.ExpiresAt.UTC().Format("2006-01-02 15:04 UTC")
	}
	raw, err := s.shellFile("share.html")
	if err != nil {
		http.Error(w, "share.html missing", 500)
		return
	}
	tpl, err := template.New("share").Funcs(template.FuncMap{"bytes": humanBytes}).Parse(string(raw))
	if err != nil {
		http.Error(w, "share.html: "+err.Error(), 500)
		return
	}
	var buf bytes.Buffer
	if err := tpl.Execute(&buf, data); err != nil {
		http.Error(w, "share.html: "+err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func humanBytes(n int64) string {
	switch {
	case n < 1024:
		return strconv.FormatInt(n, 10) + " B"
	case n < 1<<20:
		return strconv.FormatFloat(float64(n)/1024, 'f', 1, 64) + " KB"
	default:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MB"
	}
}
