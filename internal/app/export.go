package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// ---------- whole-version zip download ----------

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

// slugOf derives a filename-safe slug from an artifact title.
func slugOf(title string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if s == "" {
		return "artifact"
	}
	return s
}

// versionForExport loads a copy of artifact version n (n<=0 = latest).
func (s *Server) versionForExport(id string, n int) (*Artifact, *Version) {
	var a *Artifact
	s.store.Read(func(st *State) {
		if x := st.Artifacts[id]; x != nil {
			c := *x
			a = &c
		}
	})
	if a == nil {
		return nil, nil
	}
	v := a.Version(n)
	if v == nil {
		return nil, nil
	}
	c := *v
	return a, &c
}

// handleDownloadZip streams every file of one artifact version as a zip.
// Files are read straight from the version directory into the response:
// no temp files, folder paths preserved.
func (s *Server) handleDownloadZip(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	n, _ := strconv.Atoi(r.URL.Query().Get("v"))
	a, v := s.versionForExport(id, n)
	if v == nil {
		writeError(w, 404, "not found")
		return
	}
	root, err := os.OpenRoot(s.store.VersionDir(id, v.N))
	if err != nil {
		writeError(w, 404, "not found")
		return
	}
	defer root.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+slugOf(a.Title)+"-v"+strconv.Itoa(v.N)+`.zip"`)
	zw := zip.NewWriter(w)
	defer zw.Close()
	for _, f := range v.Files {
		zf, err := zw.Create(f.Name)
		if err != nil {
			return
		}
		src, err := root.Open(f.Name)
		if err != nil {
			return
		}
		_, err = io.Copy(zf, src)
		src.Close()
		if err != nil {
			return
		}
	}
}

// ---------- PNG/PDF export through an external renderer ----------

// renderClient talks to the optional export renderer. Rendering a page can
// take a while, so the timeout is generous.
var renderClient = &http.Client{Timeout: 2 * time.Minute}

// handleExport proxies one artifact file to the renderer configured with
// NINEARTIFACTS_RENDERER_URL and streams back the image or PDF it produces.
// Without a renderer the endpoint 404s and the UI hides the menu items.
// PNG export is one-click with fixed defaults (?selector optional); PDF
// export takes ?pageSize, ?pageWidthMm, ?pageHeightMm, ?landscape, ?margins
// and ?pageRanges, validated minimally and forwarded verbatim.
func (s *Server) handleExport(format string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.RendererURL == "" {
			writeError(w, 404, "export renderer not configured")
			return
		}
		id := r.PathValue("id")
		n, _ := strconv.Atoi(r.URL.Query().Get("v"))
		a, v := s.versionForExport(id, n)
		if v == nil {
			writeError(w, 404, "not found")
			return
		}
		name := r.URL.Query().Get("file")
		if name == "" {
			name = v.Entry
		}
		name, err := cleanName(name)
		if err != nil || !slices.ContainsFunc(v.Files, func(f File) bool { return f.Name == name }) {
			writeError(w, 404, "not found")
			return
		}
		params, err := exportParams(r, format)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		// The renderer fetches the file itself through the same signed
		// view-token URL the owner viewer uses, so no auth is needed.
		target := s.viewBase(id, v.N) + escapePath(name)
		if fileKind(name) == "markdown" {
			target += "?view=1"
		}
		payload, _ := json.Marshal(map[string]any{
			"url": target, "format": format, "params": params,
		})
		req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, strings.TrimRight(s.cfg.RendererURL, "/")+"/render", bytes.NewReader(payload))
		if err != nil {
			writeError(w, 500, "render request failed")
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := renderClient.Do(req)
		if err != nil {
			writeError(w, 502, "renderer unreachable")
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			// Surface the renderer's own error (e.g. 404 "selector matched
			// nothing") instead of masking it behind a generic 502.
			ctype := resp.Header.Get("Content-Type")
			if ctype == "" {
				ctype = "application/json; charset=utf-8"
			}
			w.Header().Set("Content-Type", ctype)
			status := resp.StatusCode
			if status < 400 || status > 599 {
				status = 502
			}
			w.WriteHeader(status)
			_, _ = io.Copy(w, resp.Body)
			return
		}
		ctype := resp.Header.Get("Content-Type")
		if ctype == "" {
			ctype = "image/png"
			if format == "pdf" {
				ctype = "application/pdf"
			}
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Content-Disposition", `attachment; filename="`+slugOf(a.Title)+"-v"+strconv.Itoa(v.N)+`.`+format+`"`)
		_, _ = io.Copy(w, resp.Body)
	}
}

// exportParams reads the renderer knobs from the query string. PNG has fixed
// server-side defaults (1280 wide, full page, 2× scale, 500 ms settle) and
// only accepts an optional capture selector. PDF takes paper size, margins,
// orientation and page ranges; page sizes are checked against the renderer's
// vocabulary, everything else passes through untouched.
func exportParams(r *http.Request, format string) (map[string]any, error) {
	q := r.URL.Query()
	p := map[string]any{"width": 1280, "height": 800, "scale": 1, "fullPage": false, "delayMs": 500}
	if format == "png" {
		p["fullPage"] = true
		p["scale"] = 2
		if sel := q.Get("selector"); sel != "" {
			p["selector"] = sel
		}
		return p, nil
	}
	p["pageSize"] = "A4"
	p["margins"] = "default"
	if raw := q.Get("pageSize"); raw != "" {
		canonical, ok := pdfPageSize(raw)
		if !ok {
			return nil, errors.New("pageSize must be one of A5, A4, A3, letter, legal, auto, custom")
		}
		p["pageSize"] = canonical
	}
	if p["pageSize"] == "custom" {
		for _, key := range []string{"pageWidthMm", "pageHeightMm"} {
			raw := q.Get(key)
			v, err := strconv.Atoi(raw)
			if raw == "" || err != nil || v < 50 || v > 3000 {
				return nil, errors.New(key + " must be an integer between 50 and 3000")
			}
			p[key] = v
		}
	}
	if raw := q.Get("landscape"); raw != "" {
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return nil, errors.New("landscape must be a boolean")
		}
		p["landscape"] = v
	}
	if raw := q.Get("margins"); raw != "" {
		p["margins"] = raw
	}
	if raw := q.Get("pageRanges"); raw != "" {
		p["pageRanges"] = raw
	}
	return p, nil
}

// pdfPageSize canonicalizes the paper-size vocabulary the renderer speaks.
func pdfPageSize(raw string) (string, bool) {
	switch strings.ToLower(raw) {
	case "a5":
		return "A5", true
	case "a4":
		return "A4", true
	case "a3":
		return "A3", true
	case "letter":
		return "letter", true
	case "legal":
		return "legal", true
	case "auto":
		return "auto", true
	case "custom":
		return "custom", true
	}
	return "", false
}

// escapePath URL-escapes each segment of a version file path, keeping the
// slashes that separate folders.
func escapePath(name string) string {
	parts := strings.Split(name, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return path.Join(parts...)
}
