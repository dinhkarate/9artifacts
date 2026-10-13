package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

// A minimal Model Context Protocol server (streamable HTTP transport,
// JSON responses, no server-initiated messages). Authenticate with
// "Authorization: Bearer vt_...".

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

const mcpInstructions = `vitrine is the user's private, self-hosted artifact gallery.
Publish finished HTML, Markdown, SVG, images or PDFs here and give the user the private URL.
Before writing an artifact, call get_design_guide and follow it so the result matches the owner's style.
To change an artifact, publish again with its id: the URL stays the same and open viewers refresh.
Never create public share links unless the user explicitly asks for one.`

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if !s.tokenAuth(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="vitrine", resource_metadata="`+s.resourceMetadataURL()+`"`)
		writeError(w, 401, "send Authorization: Bearer <vitrine API token>")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, min(s.cfg.MaxUpload, maxJSONBody)))
	if err != nil {
		writeError(w, 413, "request larger than 32 MB; use the REST API with multipart/form-data for big files")
		return
	}
	body = bytes.TrimSpace(body)
	if len(body) > 0 && body[0] == '[' {
		var batch []rpcRequest
		if err := json.Unmarshal(body, &batch); err != nil {
			writeJSON(w, 200, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
			return
		}
		var out []rpcResponse
		for _, req := range batch {
			if resp, ok := s.mcpDispatch(req); ok {
				out = append(out, resp)
			}
		}
		if len(out) == 0 {
			w.WriteHeader(202)
			return
		}
		writeJSON(w, 200, out)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, 200, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
		return
	}
	resp, ok := s.mcpDispatch(req)
	if !ok {
		w.WriteHeader(202)
		return
	}
	writeJSON(w, 200, resp)
}

// mcpDispatch returns false for notifications, which get no response.
func (s *Server) mcpDispatch(req rpcRequest) (rpcResponse, bool) {
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return rpcResponse{}, false
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		if p.ProtocolVersion == "" {
			p.ProtocolVersion = "2025-06-18"
		}
		resp.Result = map[string]any{
			"protocolVersion": p.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "vitrine", "version": s.cfg.Version},
			"instructions":    mcpInstructions,
		}
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": mcpTools}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			resp.Error = &rpcError{-32602, "invalid params"}
			break
		}
		text, err := s.mcpCall(p.Name, p.Arguments)
		if err != nil {
			resp.Result = map[string]any{"content": []map[string]string{{"type": "text", "text": "Error: " + err.Error()}}, "isError": true}
			break
		}
		resp.Result = map[string]any{"content": []map[string]string{{"type": "text", "text": text}}}
	default:
		resp.Error = &rpcError{-32601, "method not found: " + req.Method}
	}
	return resp, true
}

func schema(props map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "object", "properties": props, "required": required}
}

var (
	strProp  = map[string]any{"type": "string"}
	fileList = map[string]any{
		"type":        "array",
		"description": "Files of the artifact. Use index.html (or a single .md) as the entry; siblings like style.css or img/chart.png are referenced relatively.",
		"items": schema(map[string]any{
			"name":     map[string]any{"type": "string", "description": "Relative path, e.g. index.html or assets/logo.png"},
			"content":  map[string]any{"type": "string", "description": "File content"},
			"encoding": map[string]any{"type": "string", "enum": []string{"utf8", "base64"}, "description": "utf8 (default) for text, base64 for binary"},
		}, "name", "content"),
	}
	mcpTools = []map[string]any{
		{"name": "get_design_guide", "description": "Get the owner's design guide (design.md) and starter HTML template. Call this before writing a new artifact.",
			"inputSchema": schema(map[string]any{})},
		{"name": "publish_artifact", "description": "Publish a new artifact, or a new version of an existing one when id is given (the URL stays the same). Returns the private URL for the user.",
			"inputSchema": schema(map[string]any{
				"id":    map[string]any{"type": "string", "description": "Existing artifact id to update; omit to create a new artifact"},
				"title": strProp, "files": fileList,
				"tags":              map[string]any{"type": "array", "items": strProp},
				"note":              map[string]any{"type": "string", "description": "Private note shown only to the owner"},
				"message":           map[string]any{"type": "string", "description": "Short description of what changed in this version"},
				"replace_all_files": map[string]any{"type": "boolean", "description": "When updating: drop files not sent in this call. Default false keeps them, so you can resend only the changed files."},
			}, "files")},
		{"name": "list_artifacts", "description": "List artifacts, newest first.",
			"inputSchema": schema(map[string]any{"query": strProp, "tag": strProp, "limit": map[string]any{"type": "integer"}})},
		{"name": "read_artifact", "description": "Read the text content of an artifact file (default: the entry file of the latest version), e.g. to edit and republish it.",
			"inputSchema": schema(map[string]any{"id": strProp, "file": strProp, "version": map[string]any{"type": "integer"}}, "id")},
		{"name": "share_artifact", "description": "Create a PUBLIC expiring link anyone can open. Only call this when the user explicitly asks to share publicly.",
			"inputSchema": schema(map[string]any{"id": strProp, "ttl": map[string]any{"type": "string", "enum": []string{"1h", "24h", "7d", "30d"}},
				"note":      map[string]any{"type": "string", "description": "Public note shown on the share page"},
				"max_views": map[string]any{"type": "integer", "description": "Stop working after this many distinct visitors (omit for unlimited)"},
				"password":  map[string]any{"type": "string", "description": "Only when the user gives one: viewers must enter it"}}, "id", "ttl")},
		{"name": "revoke_share", "description": "Revoke a public share link immediately.",
			"inputSchema": schema(map[string]any{"id": strProp, "token": strProp}, "id", "token")},
		{"name": "list_comments", "description": "Read the owner's review comments on an artifact (open ones by default). Call this when the user mentions comments or feedback, then fix the artifact with publish_artifact and resolve each comment.",
			"inputSchema": schema(map[string]any{"id": strProp, "include_resolved": map[string]any{"type": "boolean"}}, "id")},
		{"name": "resolve_comment", "description": "Mark a comment as done after publishing the fix, with a short note on what changed.",
			"inputSchema": schema(map[string]any{"id": strProp, "comment_id": strProp, "note": map[string]any{"type": "string", "description": "What you changed"}}, "id", "comment_id")},
		{"name": "restore_version", "description": "Publish an earlier version again as the new latest version (history is kept). Use when the user wants to undo changes.",
			"inputSchema": schema(map[string]any{"id": strProp, "version": map[string]any{"type": "integer", "description": "Version number to restore"}}, "id", "version")},
		{"name": "delete_artifact", "description": "Permanently delete an artifact and all its versions. Only when the user explicitly asks.",
			"inputSchema": schema(map[string]any{"id": strProp}, "id")},
	}
)

func (s *Server) mcpCall(name string, raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	switch name {
	case "get_design_guide":
		design, _ := s.themeFile("design.md")
		tpl, _ := s.themeFile("template.html")
		return string(design) + "\n\n# Starter template (template.html)\n\n```html\n" + string(tpl) + "\n```", nil

	case "publish_artifact":
		var a struct {
			ID      string     `json:"id"`
			Title   *string    `json:"title"`
			Files   []jsonFile `json:"files"`
			Tags    []string   `json:"tags"`
			Note    *string    `json:"note"`
			Message string     `json:"message"`
			Replace bool       `json:"replace_all_files"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return "", errors.New("invalid arguments")
		}
		var files []upload
		for _, f := range a.Files {
			data := []byte(f.Content)
			if f.Encoding == "base64" {
				var err error
				if data, err = decodeB64(f.Content); err != nil {
					return "", fmt.Errorf("file %q: invalid base64", f.Name)
				}
			}
			files = append(files, upload{name: f.Name, open: func() (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(data)), nil
			}})
		}
		m := meta{Title: a.Title, Tags: a.Tags, Note: a.Note, Message: a.Message, Keep: !a.Replace}
		var out artifactView
		var err error
		if a.ID != "" {
			out, _, err = s.AddVersion(a.ID, m, files)
		} else {
			out, err = s.CreateArtifact(m, files)
		}
		if err != nil {
			return "", err
		}
		msg := fmt.Sprintf("Published %q (id %s, version %d).\nPrivate URL (owner login required): %s", out.Title, out.ID, out.Version, out.URL)
		if out.Open > 0 {
			msg += fmt.Sprintf("\n%d open review comment(s): if this version addresses them, call resolve_comment; see list_comments.", out.Open)
		}
		return msg, nil

	case "list_artifacts":
		var a struct {
			Query, Tag string
			Limit      int
		}
		_ = json.Unmarshal(raw, &a)
		if a.Limit <= 0 || a.Limit > 200 {
			a.Limit = 50
		}
		var b strings.Builder
		n := 0
		s.store.Read(func(st *State) {
			for _, art := range st.Sorted() {
				hay := strings.ToLower(art.Title + " " + strings.Join(art.Tags, " "))
				if a.Query != "" && !strings.Contains(hay, strings.ToLower(a.Query)) {
					continue
				}
				if a.Tag != "" && !slices.Contains(art.Tags, strings.ToLower(a.Tag)) {
					continue
				}
				if n++; n > a.Limit {
					break
				}
				fmt.Fprintf(&b, "- %s — %q v%d [%s] updated %s %s\n", art.ID, art.Title, art.Latest().N,
					strings.Join(art.Tags, ", "), art.UpdatedAt.Format("2006-01-02 15:04"), s.cfg.PublicURL+"/a/"+art.ID)
			}
		})
		if b.Len() == 0 {
			return "No artifacts found.", nil
		}
		return b.String(), nil

	case "read_artifact":
		var a struct {
			ID      string `json:"id"`
			File    string `json:"file"`
			Version int    `json:"version"`
		}
		_ = json.Unmarshal(raw, &a)
		var v *Version
		var title string
		s.store.Read(func(st *State) {
			if art := st.Artifacts[a.ID]; art != nil {
				title = art.Title
				if x := art.Version(a.Version); x != nil {
					c := *x
					v = &c
				}
			}
		})
		if v == nil {
			return "", errors.New("artifact or version not found")
		}
		file := a.File
		if file == "" {
			file = v.Entry
		}
		clean, err := cleanName(file)
		if err != nil {
			return "", err
		}
		var names []string
		found := false
		for _, f := range v.Files {
			names = append(names, f.Name)
			found = found || f.Name == clean
		}
		if !found {
			return "", fmt.Errorf("no file %q; files: %s", file, strings.Join(names, ", "))
		}
		data, err := os.ReadFile(filepath.Join(s.store.VersionDir(a.ID, v.N), filepath.FromSlash(clean)))
		if err != nil {
			return "", err
		}
		if !utf8.Valid(data) {
			return "", fmt.Errorf("%s is binary (%d bytes)", clean, len(data))
		}
		if len(data) > 400_000 {
			data = data[:400_000]
		}
		return fmt.Sprintf("Artifact %q v%d, file %s (files: %s)\n\n%s", title, v.N, clean, strings.Join(names, ", "), data), nil

	case "share_artifact":
		var a struct {
			ID, TTL, Note, Password string
			MaxViews                int `json:"max_views"`
		}
		_ = json.Unmarshal(raw, &a)
		sh, _, err := s.CreateShare(a.ID, shareOpts{TTL: a.TTL, Note: a.Note, MaxViews: a.MaxViews, Password: a.Password})
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Public link (expires %s): %s\nRevoke token: %s", sh.ExpiresAt.Format("2006-01-02 15:04 MST"), sh.URL, sh.Token), nil

	case "revoke_share":
		var a struct{ ID, Token string }
		_ = json.Unmarshal(raw, &a)
		if err := s.RevokeShare(a.ID, a.Token); err != nil {
			return "", err
		}
		return "Share revoked.", nil

	case "list_comments":
		var a struct {
			ID              string
			IncludeResolved bool `json:"include_resolved"`
		}
		_ = json.Unmarshal(raw, &a)
		var out string
		found := false
		s.store.Read(func(st *State) {
			if art := st.Artifacts[a.ID]; art != nil {
				found = true
				out = formatComments(art, a.IncludeResolved)
			}
		})
		if !found {
			return "", errors.New("artifact not found")
		}
		return out, nil

	case "resolve_comment":
		var a struct {
			ID        string
			CommentID string `json:"comment_id"`
			Note      string
		}
		_ = json.Unmarshal(raw, &a)
		if _, err := s.ResolveComment(a.ID, a.CommentID, a.Note); err != nil {
			return "", err
		}
		return "Comment resolved.", nil

	case "restore_version":
		var a struct {
			ID      string
			Version int
		}
		_ = json.Unmarshal(raw, &a)
		out, _, err := s.RestoreVersion(a.ID, a.Version)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Restored v%d as v%d: %s", a.Version, out.Version, out.URL), nil

	case "delete_artifact":
		var a struct{ ID string }
		_ = json.Unmarshal(raw, &a)
		if err := s.DeleteArtifact(a.ID); err != nil {
			return "", err
		}
		return "Artifact deleted.", nil
	}
	return "", fmt.Errorf("unknown tool %q", name)
}
