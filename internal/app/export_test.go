package app

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDownloadZip(t *testing.T) {
	e := newEnv(t, Config{PublicURL: "http://localhost:8080"})
	rec := e.upload("/api/artifacts", nil, map[string]string{
		"index.html":     "<title>Q3 Report!</title>",
		"assets/pic.jpg": "jpeg-bytes",
	})
	if rec.Code != 201 {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	a := decode[artifactView](t, rec)

	rec = e.api("GET", "/api/artifacts/"+a.ID+"/download.zip", nil)
	if rec.Code != 200 {
		t.Fatalf("zip: %d %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="q3-report-v1.zip"` {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("zip reader: %v", err)
	}
	got := map[string]string{}
	for _, f := range zr.File {
		if f.Name != "index.html" && f.Name != "assets/pic.jpg" {
			t.Fatalf("unexpected zip entry %q", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		got[f.Name] = string(b)
	}
	if got["index.html"] != "<title>Q3 Report!</title>" {
		t.Fatalf("index.html content = %q", got["index.html"])
	}
	if got["assets/pic.jpg"] != "jpeg-bytes" {
		t.Fatalf("assets/pic.jpg content = %q", got["assets/pic.jpg"])
	}

	// Unknown versions and other people's artifacts behave like handleDownload.
	if rec = e.api("GET", "/api/artifacts/"+a.ID+"/download.zip?v=99", nil); rec.Code != 404 {
		t.Fatalf("v=99: %d", rec.Code)
	}
	if rec = e.api("GET", "/api/artifacts/nope/download.zip", nil); rec.Code != 404 {
		t.Fatalf("missing: %d", rec.Code)
	}
	if rec = e.do("GET", "/api/artifacts/"+a.ID+"/download.zip", nil, nil); rec.Code != 401 {
		t.Fatalf("unauthenticated: %d", rec.Code)
	}
}

func TestExportUnconfigured(t *testing.T) {
	e := newEnv(t, Config{PublicURL: "http://localhost:8080"})
	rec := e.upload("/api/artifacts", nil, map[string]string{"index.html": "<title>R</title>"})
	a := decode[artifactView](t, rec)
	if len(a.Exports) != 0 {
		t.Fatalf("exports advertised without renderer: %+v", a.Exports)
	}
	for _, path := range []string{"export.png", "export.pdf"} {
		if rec = e.api("GET", "/api/artifacts/"+a.ID+"/"+path, nil); rec.Code != 404 {
			t.Fatalf("%s without renderer: %d", path, rec.Code)
		} else if !strings.Contains(rec.Body.String(), `"error"`) {
			t.Fatalf("%s without renderer: body %s", path, rec.Body)
		}
	}
}

func TestExport(t *testing.T) {
	type renderReq struct {
		URL    string         `json:"url"`
		Format string         `json:"format"`
		Params map[string]any `json:"params"`
	}
	var last renderReq
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/render" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&last); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		switch last.Format {
		case "png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("\x89PNG\r\n\x1a\n"))
		case "pdf":
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF-1.4"))
		default:
			http.Error(w, "bad format", 400)
		}
	}))
	defer stub.Close()

	e := newEnv(t, Config{PublicURL: "http://localhost:8080", RendererURL: stub.URL})
	rec := e.upload("/api/artifacts", nil, map[string]string{
		"index.html": "<title>Slides Deck</title>",
		"other.html": "<p>other</p>",
	})
	a := decode[artifactView](t, rec)
	if strings.Join(a.Exports, ",") != "png,pdf" {
		t.Fatalf("exports = %+v", a.Exports)
	}

	rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.png", nil)
	if rec.Code != 200 {
		t.Fatalf("export.png: %d %s", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("png Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="slides-deck-v1.png"` {
		t.Fatalf("png Content-Disposition = %q", cd)
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("\x89PNG")) {
		t.Fatalf("png body = %q", rec.Body.String())
	}
	if last.Format != "png" {
		t.Fatalf("render request = %+v", last)
	}
	if !strings.HasPrefix(last.URL, "http://localhost:8080/c/") || !strings.HasSuffix(last.URL, "/index.html") {
		t.Fatalf("render url = %q", last.URL)
	}
	// Defaults for the V2 knobs: one-click PNG is full-page at 2× scale.
	want := map[string]any{"width": 1280.0, "height": 800.0, "scale": 2.0, "fullPage": true, "delayMs": 500.0}
	for k, v := range want {
		if last.Params[k] != v {
			t.Fatalf("param %s = %v, want %v", k, last.Params[k], v)
		}
	}

	// The only PNG knob is the capture selector.
	rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.png?selector=.msg", nil)
	if rec.Code != 200 {
		t.Fatalf("png selector: %d %s", rec.Code, rec.Body)
	}
	if last.Params["selector"] != ".msg" || last.Params["fullPage"] != true || last.Params["scale"] != 2.0 {
		t.Fatalf("png selector params = %+v", last.Params)
	}

	rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.pdf?file=other.html", nil)
	if rec.Code != 200 || !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatalf("export.pdf: %d %q", rec.Code, rec.Body.String())
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="slides-deck-v1.pdf"` {
		t.Fatalf("pdf Content-Disposition = %q", cd)
	}
	if last.Format != "pdf" || !strings.HasSuffix(last.URL, "/other.html") {
		t.Fatalf("render request = %+v", last)
	}
	if last.Params["pageSize"] != "A4" || last.Params["margins"] != "default" {
		t.Fatalf("pdf defaults = %+v", last.Params)
	}

	// PDF knobs pass through verbatim.
	rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.pdf?landscape=true&pageSize=letter&margins=none&pageRanges=1,3-4", nil)
	if rec.Code != 200 {
		t.Fatalf("pdf knobs: %d %s", rec.Code, rec.Body)
	}
	want = map[string]any{"landscape": true, "pageSize": "letter", "margins": "none", "pageRanges": "1,3-4"}
	for k, v := range want {
		if last.Params[k] != v {
			t.Fatalf("param %s = %v, want %v", k, last.Params[k], v)
		}
	}

	// Custom paper sizes carry their dimensions in millimetres.
	rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.pdf?pageSize=custom&pageWidthMm=148&pageHeightMm=210", nil)
	if rec.Code != 200 {
		t.Fatalf("custom size: %d %s", rec.Code, rec.Body)
	}
	if last.Params["pageSize"] != "custom" || last.Params["pageWidthMm"] != 148.0 || last.Params["pageHeightMm"] != 210.0 {
		t.Fatalf("custom params = %+v", last.Params)
	}

	// Malformed knobs are rejected with 400 JSON before the renderer runs.
	for _, qs := range []string{"pageSize=bogus", "pageSize=custom", "pageSize=custom&pageWidthMm=10&pageHeightMm=210",
		"pageSize=custom&pageWidthMm=148&pageHeightMm=abc", "landscape=maybe"} {
		if rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.pdf?"+qs, nil); rec.Code != 400 {
			t.Fatalf("%s: %d, want 400", qs, rec.Code)
		} else if !strings.Contains(rec.Body.String(), `"error"`) {
			t.Fatalf("%s: body %s", qs, rec.Body)
		}
	}

	// Renderer errors keep their status and body.
	stub2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"selector matched nothing"}`))
	}))
	defer stub2.Close()
	e2 := newEnv(t, Config{PublicURL: "http://localhost:8080", RendererURL: stub2.URL})
	rec = e2.upload("/api/artifacts", nil, map[string]string{"index.html": "<title>X</title>"})
	a2 := decode[artifactView](t, rec)
	if rec = e2.api("GET", "/api/artifacts/"+a2.ID+"/export.png?selector=.nope", nil); rec.Code != 404 {
		t.Fatalf("renderer 404 passthrough: %d", rec.Code)
	} else if !strings.Contains(rec.Body.String(), "selector matched nothing") {
		t.Fatalf("renderer error body = %s", rec.Body)
	}

	// Unknown files, unknown versions and unauthenticated requests fail
	// before the renderer is ever called.
	if rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.png?file=missing.html", nil); rec.Code != 404 {
		t.Fatalf("file=missing: %d", rec.Code)
	}
	if rec = e.api("GET", "/api/artifacts/"+a.ID+"/export.png?v=99", nil); rec.Code != 404 {
		t.Fatalf("v=99: %d", rec.Code)
	}
	if rec = e.do("GET", "/api/artifacts/"+a.ID+"/export.pdf", nil, nil); rec.Code != 401 {
		t.Fatalf("unauthenticated: %d", rec.Code)
	}
}
