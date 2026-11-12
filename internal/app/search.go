package app

import (
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Search also looks inside the entry file of the latest version. Only the
// first searchRead bytes are read and searchKeep bytes of text are kept
// per artifact, so the index stays small on a 128 MB container.
const (
	searchRead = 512 << 10
	searchKeep = 64 << 10
)

var (
	searchable = map[string]bool{".html": true, ".htm": true, ".md": true, ".txt": true, ".csv": true, ".svg": true}
	reHidden   = regexp.MustCompile(`(?is)<(script|style)\b.*?</(script|style)>`)
	reTag      = regexp.MustCompile(`(?s)<[^>]*>`)
)

type searchIndex struct {
	mu   sync.Mutex
	text map[string]searchText // artifact id → text of its latest version
}

type searchText struct {
	n    int
	text string
}

// contentMatches reports whether the latest version's entry file contains
// q, which must already be lowercase.
func (s *Server) contentMatches(a *Artifact, q string) bool {
	v := a.Latest()
	if !searchable[strings.ToLower(path.Ext(v.Entry))] {
		return false
	}
	s.search.mu.Lock()
	defer s.search.mu.Unlock()
	t, ok := s.search.text[a.ID]
	if !ok || t.n != v.N {
		t = searchText{n: v.N, text: s.readSearchText(a.ID, v)}
		if s.search.text == nil {
			s.search.text = map[string]searchText{}
		}
		s.search.text[a.ID] = t
	}
	return strings.Contains(t.text, q)
}

func (s *Server) readSearchText(id string, v *Version) string {
	f, err := os.Open(filepath.Join(s.store.VersionDir(id, v.N), filepath.FromSlash(v.Entry)))
	if err != nil {
		return ""
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, searchRead))
	text := string(b)
	if ext := strings.ToLower(path.Ext(v.Entry)); ext == ".html" || ext == ".htm" || ext == ".svg" {
		text = reTag.ReplaceAllString(reHidden.ReplaceAllString(text, " "), " ")
	}
	text = strings.ToLower(strings.Join(strings.Fields(text), " "))
	if len(text) > searchKeep {
		text = text[:searchKeep]
	}
	return text
}

func (s *Server) forgetSearchText(id string) {
	s.search.mu.Lock()
	delete(s.search.text, id)
	s.search.mu.Unlock()
}
