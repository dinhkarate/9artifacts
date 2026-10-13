package app

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dinhkarate/vitrine/internal/webauthn"
)

// File is one uploaded file inside an artifact version.
type File struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Type string `json:"type"`
}

// Version is an immutable snapshot of an artifact's files.
type Version struct {
	N         int       `json:"n"`
	Files     []File    `json:"files"`
	Entry     string    `json:"entry"`
	Message   string    `json:"message,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// Share is a public, expiring link to an artifact.
type Share struct {
	Token     string     `json:"token"`
	Version   int        `json:"version,omitempty"` // 0 follows the latest version
	Note      string     `json:"note,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt time.Time  `json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt,omitempty"`
	// Views counts distinct visitors (one per address per hour).
	Views        int        `json:"views,omitempty"`
	MaxViews     int        `json:"maxViews,omitempty"` // 0 means unlimited
	LastViewedAt *time.Time `json:"lastViewedAt,omitempty"`
	PasswordHash string     `json:"passwordHash,omitempty"` // viewers must enter this password
}

// Active reports whether the share link still works.
// Live reports whether the link is neither revoked nor expired.
func (s Share) Live(now time.Time) bool { return s.RevokedAt == nil && now.Before(s.ExpiresAt) }

// Active reports whether new visitors can still open the link.
func (s Share) Active(now time.Time) bool {
	return s.Live(now) && (s.MaxViews == 0 || s.Views < s.MaxViews)
}

// Artifact is a titled, tagged, versioned bundle of files.
type Artifact struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Tags      []string  `json:"tags"`
	Note      string    `json:"note,omitempty"`
	Pinned    bool      `json:"pinned,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Versions  []Version `json:"versions"`
	Shares    []Share   `json:"shares"`
}

// Latest returns the newest version.
func (a *Artifact) Latest() *Version { return &a.Versions[len(a.Versions)-1] }

// Version returns version n, or the latest when n is 0.
func (a *Artifact) Version(n int) *Version {
	if n <= 0 {
		return a.Latest()
	}
	for i := range a.Versions {
		if a.Versions[i].N == n {
			return &a.Versions[i]
		}
	}
	return nil
}

// Passkey is a registered WebAuthn credential with a friendly name.
type Passkey struct {
	webauthn.Credential
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// Token is an API token for agents and the CLI. Only its hash is stored.
type Token struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Hash       string     `json:"hash"`
	Prefix     string     `json:"prefix"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
}

// State is everything vitrine persists apart from the file bytes.
type State struct {
	PasswordHash string               `json:"passwordHash,omitempty"`
	SigningKey   []byte               `json:"signingKey"`
	Passkeys     []Passkey            `json:"passkeys"`
	Tokens       []Token              `json:"tokens"`
	Sessions     map[string]time.Time `json:"sessions"` // sha256(session id) → expiry
	Artifacts    map[string]*Artifact `json:"artifacts"`
}

// Store guards State and writes it atomically to <dir>/vitrine.json.
type Store struct {
	mu   sync.RWMutex
	dir  string
	path string
	s    State
}

// OpenStore loads or initialises the data directory.
func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "artifacts"), 0o700); err != nil {
		return nil, err
	}
	st := &Store{dir: dir, path: filepath.Join(dir, "vitrine.json")}
	raw, err := os.ReadFile(st.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(raw, &st.s); err != nil {
			return nil, err
		}
	}
	if len(st.s.SigningKey) < 32 {
		st.s.SigningKey = randomBytes(32)
	}
	if st.s.Sessions == nil {
		st.s.Sessions = map[string]time.Time{}
	}
	if st.s.Artifacts == nil {
		st.s.Artifacts = map[string]*Artifact{}
	}
	return st, st.saveLocked()
}

// Read runs fn with a read lock.
func (st *Store) Read(fn func(s *State)) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	fn(&st.s)
}

// Update runs fn with the write lock and persists the result unless fn
// returns an error.
func (st *Store) Update(fn func(s *State) error) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := fn(&st.s); err != nil {
		return err
	}
	return st.saveLocked()
}

func (st *Store) saveLocked() error {
	now := time.Now()
	for k, exp := range st.s.Sessions {
		if now.After(exp) {
			delete(st.s.Sessions, k)
		}
	}
	raw, err := json.MarshalIndent(&st.s, "", " ")
	if err != nil {
		return err
	}
	tmp := st.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, st.path)
}

// VersionDir is where the files of one artifact version live.
func (st *Store) VersionDir(id string, n int) string {
	return filepath.Join(st.dir, "artifacts", id, "v"+strconv.Itoa(n))
}

// ArtifactDir is the root directory of one artifact.
func (st *Store) ArtifactDir(id string) string { return filepath.Join(st.dir, "artifacts", id) }

// Sorted returns artifacts newest first, pinned ones on top.
func (s *State) Sorted() []*Artifact {
	list := make([]*Artifact, 0, len(s.Artifacts))
	for _, a := range s.Artifacts {
		list = append(list, a)
	}
	slices.SortFunc(list, func(a, b *Artifact) int {
		if a.Pinned != b.Pinned {
			if a.Pinned {
				return -1
			}
			return 1
		}
		return b.UpdatedAt.Compare(a.UpdatedAt)
	})
	return list
}

// FindShare locates an artifact by one of its share tokens.
func (s *State) FindShare(token string) (*Artifact, *Share) {
	for _, a := range s.Artifacts {
		for i := range a.Shares {
			if a.Shares[i].Token == token {
				return a, &a.Shares[i]
			}
		}
	}
	return nil, nil
}

var idEncoding = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

// newID returns a lowercase, URL-safe random identifier of n bytes entropy.
func newID(n int) string { return idEncoding.EncodeToString(randomBytes(n)) }

// normTags lowercases, trims, de-duplicates and caps tag lists.
func normTags(in []string) []string {
	var out []string
	for _, raw := range in {
		for _, t := range strings.Split(raw, ",") {
			t = strings.ToLower(strings.TrimSpace(t))
			t = strings.Join(strings.Fields(t), "-")
			if t == "" || len(t) > 40 || slices.Contains(out, t) {
				continue
			}
			out = append(out, t)
			if len(out) == 20 {
				return out
			}
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}
