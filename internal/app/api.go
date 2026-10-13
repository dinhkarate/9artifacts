package app

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dinhkarate/vitrine/internal/markdown"
)

const (
	maxFilesPerVersion = 500
	// JSON and MCP bodies are decoded in memory; large uploads use multipart.
	maxJSONBody = 32 << 20
)

// ShareTTLs are the allowed lifetimes of a public link.
var ShareTTLs = map[string]time.Duration{
	"1h": time.Hour, "24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour,
}

// upload is one incoming file, from multipart or JSON.
type upload struct {
	name string
	open func() (io.ReadCloser, error)
}

type meta struct {
	Title   *string  `json:"title"`
	Tags    []string `json:"tags"`
	Note    *string  `json:"note"`
	Pinned  *bool    `json:"pinned"`
	Entry   string   `json:"entry"`
	Message string   `json:"message"`
	Keep    bool     `json:"keep"` // new version: carry over files not re-uploaded
}

type jsonFile struct {
	Name     string `json:"name"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // "utf8" (default) or "base64"
}

var segmentRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._ ()+-]{0,127}$`)

// cleanName validates an uploaded path such as "assets/chart.png". It is
// only ever joined under a version directory the server created.
func cleanName(name string) (string, error) {
	name = strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")
	name = strings.TrimPrefix(name, "./")
	if name == "" || len(name) > 300 {
		return "", errors.New("invalid file name")
	}
	parts := strings.Split(name, "/")
	if len(parts) > 8 {
		return "", errors.New("file path too deep")
	}
	for _, p := range parts {
		if !segmentRe.MatchString(p) || strings.Contains(p, "..") {
			return "", fmt.Errorf("invalid file name %q (letters, digits, . _ - only)", name)
		}
	}
	return strings.Join(parts, "/"), nil
}

// errTooLarge marks uploads over the size limit (HTTP 413).
var errTooLarge = errors.New("upload too large")

func uploadStatus(err error) int {
	if errors.Is(err, errTooLarge) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}

// parseUpload reads either multipart/form-data (fields: title, tags, note,
// entry, message, files[]) or JSON ({title, tags, files:[{name, content,
// encoding}]}).
func (s *Server) parseUpload(w http.ResponseWriter, r *http.Request) (meta, []upload, error) {
	limit := s.cfg.MaxUpload
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		limit = min(limit, maxJSONBody)
	}
	tooLarge := fmt.Errorf("%w: the limit is %d MB (multipart) and 32 MB (JSON); raise it with --max-upload-mb", errTooLarge, s.cfg.MaxUpload>>20)
	if r.ContentLength > limit {
		return meta{}, nil, tooLarge
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	var m meta
	var files []upload
	ct := r.Header.Get("Content-Type")
	switch {
	case strings.HasPrefix(ct, "multipart/form-data"):
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
				return m, nil, tooLarge
			}
			return m, nil, fmt.Errorf("malformed upload: %w", err)
		}
		f := r.MultipartForm
		if v := f.Value["title"]; len(v) > 0 {
			m.Title = &v[0]
		}
		if v := f.Value["note"]; len(v) > 0 {
			m.Note = &v[0]
		}
		m.Tags = f.Value["tags"]
		if v := f.Value["entry"]; len(v) > 0 {
			m.Entry = v[0]
		}
		if v := f.Value["message"]; len(v) > 0 {
			m.Message = v[0]
		}
		if v := f.Value["keep"]; len(v) > 0 {
			m.Keep = v[0] == "1" || v[0] == "true"
		}
		for _, key := range []string{"files", "file", "files[]"} {
			for _, fh := range f.File[key] {
				fh := fh
				// FileHeader.Filename drops directories; read the raw
				// header so "assets/logo.png" keeps its folder.
				name := fh.Filename
				if _, params, err := mime.ParseMediaType(fh.Header.Get("Content-Disposition")); err == nil && params["filename"] != "" {
					name = params["filename"]
				}
				files = append(files, upload{name: name, open: func() (io.ReadCloser, error) { return fh.Open() }})
			}
		}
	case strings.HasPrefix(ct, "application/json"):
		var body struct {
			meta
			Files []jsonFile `json:"files"`
		}
		dec := json.NewDecoder(r.Body)
		if err := dec.Decode(&body); err != nil {
			if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
				return m, nil, tooLarge
			}
			return m, nil, errors.New("invalid JSON body")
		}
		m = body.meta
		for _, jf := range body.Files {
			jf := jf
			var data []byte
			if jf.Encoding == "base64" {
				b, err := decodeB64(jf.Content)
				if err != nil {
					return m, nil, fmt.Errorf("file %q: invalid base64", jf.Name)
				}
				data = b
			} else {
				data = []byte(jf.Content)
			}
			files = append(files, upload{name: jf.Name, open: func() (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(data)), nil
			}})
		}
	default:
		return m, nil, errors.New("send multipart/form-data or application/json")
	}
	if len(files) > maxFilesPerVersion {
		return m, nil, fmt.Errorf("at most %d files per version", maxFilesPerVersion)
	}
	return m, files, nil
}

// writeVersion stores files as the next version of artifact id. It writes
// into a temporary directory and renames it into place.
func (s *Server) writeVersion(id string, n int, entry, message string, files []upload) (*Version, error) {
	if len(files) == 0 {
		return nil, errors.New("no files uploaded")
	}
	base := s.store.ArtifactDir(id)
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, err
	}
	tmp, err := os.MkdirTemp(base, ".upload-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	root, err := os.OpenRoot(tmp)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	v := &Version{N: n, CreatedAt: time.Now().UTC(), Message: truncate(message, 200)}
	seen := map[string]bool{}
	for _, u := range files {
		name, err := cleanName(u.name)
		if err != nil {
			return nil, err
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate file %q", name)
		}
		seen[name] = true
		if dir := path.Dir(name); dir != "." {
			if err := root.MkdirAll(dir, 0o700); err != nil {
				return nil, err
			}
		}
		src, err := u.open()
		if err != nil {
			return nil, err
		}
		dst, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			src.Close()
			return nil, err
		}
		size, err := io.Copy(dst, src)
		src.Close()
		if cerr := dst.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return nil, err
		}
		v.Files = append(v.Files, File{Name: name, Size: size, Type: contentType(name)})
	}
	v.Entry = pickEntry(v.Files, entry)
	if err := os.Rename(tmp, s.store.VersionDir(id, n)); err != nil {
		return nil, err
	}
	return v, nil
}

func decodeB64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

func pickEntry(files []File, want string) string {
	names := make([]string, len(files))
	for i, f := range files {
		names[i] = f.Name
	}
	if want != "" && slices.Contains(names, want) {
		return want
	}
	if slices.Contains(names, "index.html") {
		return "index.html"
	}
	for _, ext := range []string{".html", ".htm", ".md", ".pdf", ".svg", ".png", ".jpg", ".jpeg", ".webp"} {
		for _, n := range names {
			if !strings.Contains(n, "/") && strings.HasSuffix(strings.ToLower(n), ext) {
				return n
			}
		}
	}
	return names[0]
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) > n {
		return string([]rune(s)[:n])
	}
	return s
}

// guessTitle derives a title from the entry file when none was given.
func (s *Server) guessTitle(id string, v *Version) string {
	p := filepath.Join(s.store.VersionDir(id, v.N), filepath.FromSlash(v.Entry))
	raw, err := readHead(p, 64<<10)
	if err == nil {
		lower := strings.ToLower(v.Entry)
		switch {
		case strings.HasSuffix(lower, ".md"):
			if t := markdown.Title(raw); t != "" {
				return truncate(t, 160)
			}
		case strings.HasSuffix(lower, ".html") || strings.HasSuffix(lower, ".htm"):
			if m := titleRe.FindStringSubmatch(raw); m != nil {
				if t := strings.TrimSpace(html.UnescapeString(m[1])); t != "" {
					return truncate(t, 160)
				}
			}
		}
	}
	name := path.Base(v.Entry)
	return strings.TrimSuffix(name, path.Ext(name))
}

var titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

func readHead(p string, n int64) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, n))
	return string(b), err
}

// ---------- JSON views ----------

type versionView struct {
	N         int       `json:"n"`
	Entry     string    `json:"entry"`
	Files     []File    `json:"files"`
	Message   string    `json:"message,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	ViewBase  string    `json:"viewBase"`
}

type shareView struct {
	Token     string     `json:"token"`
	URL       string     `json:"url"`
	Version   int        `json:"version"`
	Note      string     `json:"note,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt time.Time  `json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
	Active    bool       `json:"active"`
}

type artifactView struct {
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	Tags      []string      `json:"tags"`
	Note      string        `json:"note"`
	Pinned    bool          `json:"pinned"`
	CreatedAt time.Time     `json:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt"`
	URL       string        `json:"url"`
	Version   int           `json:"version"`
	Entry     string        `json:"entry"`
	Files     []File        `json:"files"`
	Size      int64         `json:"size"`
	ViewBase  string        `json:"viewBase"`
	Versions  []versionView `json:"versions,omitempty"`
	Shares    []shareView   `json:"shares"`
	Active    int           `json:"activeShares"`
}

func (s *Server) view(a *Artifact, full bool) artifactView {
	now := time.Now()
	lv := a.Latest()
	out := artifactView{
		ID: a.ID, Title: a.Title, Tags: a.Tags, Note: a.Note, Pinned: a.Pinned,
		CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt, URL: s.cfg.PublicURL + "/a/" + a.ID,
		Version: lv.N, Entry: lv.Entry, Files: lv.Files, ViewBase: s.viewBase(a.ID, lv.N), Shares: []shareView{},
	}
	for _, f := range lv.Files {
		out.Size += f.Size
	}
	for _, sh := range a.Shares {
		if sh.Active(now) {
			out.Active++
		}
		if full {
			out.Shares = append(out.Shares, shareView{Token: sh.Token, URL: s.cfg.PublicURL + "/s/" + sh.Token,
				Version: sh.Version, Note: sh.Note, CreatedAt: sh.CreatedAt, ExpiresAt: sh.ExpiresAt,
				RevokedAt: sh.RevokedAt, Active: sh.Active(now)})
		}
	}
	if full {
		for i := len(a.Versions) - 1; i >= 0; i-- {
			v := a.Versions[i]
			out.Versions = append(out.Versions, versionView{N: v.N, Entry: v.Entry, Files: v.Files,
				Message: v.Message, CreatedAt: v.CreatedAt, ViewBase: s.viewBase(a.ID, v.N)})
		}
	}
	return out
}

// ---------- handlers ----------

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	tag := strings.ToLower(r.URL.Query().Get("tag"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items := []artifactView{}
	tags := map[string]int{}
	s.store.Read(func(st *State) {
		for _, a := range st.Sorted() {
			for _, t := range a.Tags {
				tags[t]++
			}
			if tag != "" && !slices.Contains(a.Tags, tag) {
				continue
			}
			if q != "" && !strings.Contains(strings.ToLower(a.Title+" "+strings.Join(a.Tags, " ")+" "+a.Note), q) {
				continue
			}
			if limit > 0 && len(items) >= limit {
				continue
			}
			items = append(items, s.view(a, false))
		}
	})
	writeJSON(w, 200, map[string]any{"artifacts": items, "tags": tags})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	var out *artifactView
	s.store.Read(func(st *State) {
		if a := st.Artifacts[r.PathValue("id")]; a != nil {
			v := s.view(a, true)
			out = &v
		}
	})
	if out == nil {
		writeError(w, 404, "artifact not found")
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	m, files, err := s.parseUpload(w, r)
	if err != nil {
		writeError(w, uploadStatus(err), err.Error())
		return
	}
	a, err := s.CreateArtifact(m, files)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 201, a)
}

// CreateArtifact stores a new artifact (used by the HTTP API and MCP).
func (s *Server) CreateArtifact(m meta, files []upload) (artifactView, error) {
	id := newID(8)
	v, err := s.writeVersion(id, 1, m.Entry, m.Message, files)
	if err != nil {
		os.RemoveAll(s.store.ArtifactDir(id))
		return artifactView{}, err
	}
	title := ""
	if m.Title != nil {
		title = truncate(*m.Title, 160)
	}
	if title == "" {
		title = s.guessTitle(id, v)
	}
	now := time.Now().UTC()
	a := &Artifact{ID: id, Title: title, Tags: normTags(m.Tags), CreatedAt: now, UpdatedAt: now,
		Versions: []Version{*v}, Shares: []Share{}}
	if m.Note != nil {
		a.Note = truncate(*m.Note, 4000)
	}
	if m.Pinned != nil {
		a.Pinned = *m.Pinned
	}
	var out artifactView
	err = s.store.Update(func(st *State) error {
		st.Artifacts[id] = a
		out = s.view(a, true)
		return nil
	})
	return out, err
}

func (s *Server) handleNewVersion(w http.ResponseWriter, r *http.Request) {
	m, files, err := s.parseUpload(w, r)
	if err != nil {
		writeError(w, uploadStatus(err), err.Error())
		return
	}
	out, status, err := s.AddVersion(r.PathValue("id"), m, files)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, 201, out)
}

// AddVersion publishes new files to an existing artifact; the private URL
// stays the same and open viewers refresh to the new version.
func (s *Server) AddVersion(id string, m meta, files []upload) (artifactView, int, error) {
	next := 0
	var prev Version
	s.store.Read(func(st *State) {
		if a := st.Artifacts[id]; a != nil {
			prev = *a.Latest()
			next = prev.N + 1
		}
	})
	if next == 0 {
		return artifactView{}, 404, errors.New("artifact not found")
	}
	if m.Keep {
		uploaded := map[string]bool{}
		for _, u := range files {
			if n, err := cleanName(u.name); err == nil {
				uploaded[n] = true
			}
		}
		dir := s.store.VersionDir(id, prev.N)
		for _, f := range prev.Files {
			if !uploaded[f.Name] {
				p := filepath.Join(dir, filepath.FromSlash(f.Name))
				files = append(files, upload{name: f.Name, open: func() (io.ReadCloser, error) { return os.Open(p) }})
			}
		}
		if m.Entry == "" {
			m.Entry = prev.Entry
		}
	}
	v, err := s.writeVersion(id, next, m.Entry, m.Message, files)
	if err != nil {
		return artifactView{}, 400, err
	}
	var out artifactView
	err = s.store.Update(func(st *State) error {
		a := st.Artifacts[id]
		if a == nil {
			return errors.New("artifact was deleted")
		}
		if a.Latest().N >= next {
			return errors.New("concurrent update, retry")
		}
		a.Versions = append(a.Versions, *v)
		a.UpdatedAt = v.CreatedAt
		applyMeta(a, m)
		out = s.view(a, true)
		return nil
	})
	if err != nil {
		os.RemoveAll(s.store.VersionDir(id, next))
		return artifactView{}, 409, err
	}
	return out, 201, nil
}

func applyMeta(a *Artifact, m meta) {
	if m.Title != nil && strings.TrimSpace(*m.Title) != "" {
		a.Title = truncate(*m.Title, 160)
	}
	if m.Tags != nil {
		a.Tags = normTags(m.Tags)
	}
	if m.Note != nil {
		a.Note = truncate(*m.Note, 4000)
	}
	if m.Pinned != nil {
		a.Pinned = *m.Pinned
	}
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request) {
	var m meta
	if err := readJSON(r, &m); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var out artifactView
	err := s.store.Update(func(st *State) error {
		a := st.Artifacts[r.PathValue("id")]
		if a == nil {
			return errors.New("artifact not found")
		}
		applyMeta(a, m)
		out = s.view(a, true)
		return nil
	})
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.DeleteArtifact(id); err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// DeleteArtifact removes an artifact, its versions and its share links.
func (s *Server) DeleteArtifact(id string) error {
	err := s.store.Update(func(st *State) error {
		if st.Artifacts[id] == nil {
			return errors.New("artifact not found")
		}
		delete(st.Artifacts, id)
		return nil
	})
	if err != nil {
		return err
	}
	return os.RemoveAll(s.store.ArtifactDir(id))
}

func (s *Server) handleShareCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TTL     string `json:"ttl"`
		Note    string `json:"note"`
		Version int    `json:"version"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	sh, status, err := s.CreateShare(r.PathValue("id"), body.TTL, body.Note, body.Version)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, 201, sh)
}

// CreateShare issues an expiring public link. Every link must expire.
func (s *Server) CreateShare(id, ttl, note string, version int) (shareView, int, error) {
	if ttl == "" {
		ttl = "7d"
	}
	d, ok := ShareTTLs[ttl]
	if !ok {
		return shareView{}, 400, errors.New("ttl must be one of 1h, 24h, 7d, 30d")
	}
	now := time.Now().UTC()
	sh := Share{Token: b64.EncodeToString(randomBytes(18)), Version: version, Note: truncate(note, 1000),
		CreatedAt: now, ExpiresAt: now.Add(d)}
	err := s.store.Update(func(st *State) error {
		a := st.Artifacts[id]
		if a == nil {
			return errors.New("artifact not found")
		}
		if version != 0 && a.Version(version) == nil {
			return errors.New("no such version")
		}
		// Pin the link to what the owner is sharing now; later versions
		// stay private until they share again.
		if version == 0 {
			sh.Version = a.Latest().N
		}
		// Keep the list bounded: drop links that died more than 30 days ago.
		a.Shares = slices.DeleteFunc(a.Shares, func(x Share) bool {
			return !x.Active(now) && now.Sub(x.ExpiresAt) > 30*24*time.Hour
		})
		a.Shares = append(a.Shares, sh)
		return nil
	})
	if err != nil {
		return shareView{}, 404, err
	}
	return shareView{Token: sh.Token, URL: s.cfg.PublicURL + "/s/" + sh.Token, Version: sh.Version, Note: sh.Note,
		CreatedAt: now, ExpiresAt: sh.ExpiresAt, Active: true}, 201, nil
}

func (s *Server) handleShareRevoke(w http.ResponseWriter, r *http.Request) {
	if err := s.RevokeShare(r.PathValue("id"), r.PathValue("token")); err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// RevokeShare kills a public link immediately.
func (s *Server) RevokeShare(id, token string) error {
	return s.store.Update(func(st *State) error {
		a := st.Artifacts[id]
		if a == nil {
			return errors.New("artifact not found")
		}
		for i := range a.Shares {
			if a.Shares[i].Token == token {
				if a.Shares[i].RevokedAt == nil {
					now := time.Now().UTC()
					a.Shares[i].RevokedAt = &now
				}
				return nil
			}
		}
		return errors.New("share not found")
	})
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, _ := strconv.Atoi(r.URL.Query().Get("v"))
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
		writeError(w, 404, "not found")
		return
	}
	s.serveVersionFile(w, r, id, v, r.PathValue("path"), true, false)
}
