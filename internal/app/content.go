package app

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"html/template"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/dinhkarate/vitrine/internal/markdown"
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
	s.serveVersionFile(w, r, id, v, r.PathValue("path"), r.URL.Query().Has("download"), r.URL.Query().Has("view"))
}

func (s *Server) handleShareContent(w http.ResponseWriter, r *http.Request) {
	id, v, _, status := s.resolveShare(r.PathValue("token"))
	if status != 200 {
		http.Error(w, http.StatusText(status), status)
		return
	}
	s.serveVersionFile(w, r, id, v, r.PathValue("path"), r.URL.Query().Has("download"), r.URL.Query().Has("view"))
}

// resolveShare returns the artifact id, version and title for an active
// share token, or 404/410.
func (s *Server) resolveShare(token string) (id string, v *Version, sh Share, status int) {
	status = 404
	s.store.Read(func(st *State) {
		a, share := st.FindShare(token)
		if a == nil {
			return
		}
		sh = *share
		if !share.Active(time.Now()) {
			status = 410
			return
		}
		if x := a.Version(share.Version); x != nil {
			c := *x
			id, v, status = a.ID, &c, 200
		}
	})
	return id, v, sh, status
}

func needsSandbox(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm", ".svg", ".xml", ".xhtml", ".md":
		return true
	}
	return false
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

func (s *Server) serveVersionFile(w http.ResponseWriter, r *http.Request, id string, v *Version, name string, download, render bool) {
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
		_, _ = w.Write(s.markdownPage(path.Base(name), string(raw)))
		return
	}
	s.contentHeaders(w, needsSandbox(name))
	w.Header().Set("Content-Type", contentType(name))
	http.ServeContent(w, r, "", st.ModTime(), f)
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
	id, v, sh, status := s.resolveShare(token)
	var title string
	if status == 200 {
		s.store.Read(func(st *State) { title = st.Artifacts[id].Title })
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
	data := map[string]any{"Name": s.cfg.Name, "Status": status, "Version": s.cfg.Version}
	if status == 200 {
		base := s.contentOrigin() + "/s/" + token + "/f/"
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
