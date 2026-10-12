package app

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// AdminSocketPath is the Unix socket the running server exposes for local
// administration. Access is controlled by filesystem permissions (0600),
// so anyone who can read the data directory is already the owner.
// Socket paths are limited to ~104 bytes; for deep data directories the
// socket moves to a private per-user directory under the temp dir.
func AdminSocketPath(dataDir string) string {
	p := filepath.Join(dataDir, "admin.sock")
	if len(p) < 100 {
		return p
	}
	abs, _ := filepath.Abs(dataDir)
	sum := sha256.Sum256([]byte(abs))
	return filepath.Join(os.TempDir(), "vitrine-"+strconv.Itoa(os.Getuid()), hex.EncodeToString(sum[:6])+".sock")
}

// ServeAdmin listens on the admin socket until the listener fails.
func (s *Server) ServeAdmin() error {
	sock := AdminSocketPath(s.store.dir)
	if dir := filepath.Dir(sock); dir != s.store.dir {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if st, err := os.Lstat(dir); err != nil || !st.IsDir() || st.Mode().Perm() != 0o700 {
			return errors.New("refusing insecure admin socket directory " + dir)
		}
	}
	_ = os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	if err := os.Chmod(sock, 0o600); err != nil {
		ln.Close()
		return err
	}
	m := http.NewServeMux()
	m.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Name string }
		_ = readJSON(r, &body)
		secret, t, err := s.store.CreateToken(body.Name)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		writeJSON(w, 201, map[string]string{"id": t.ID, "name": t.Name, "token": secret})
	})
	m.HandleFunc("POST /password", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Password string }
		if err := readJSON(r, &body); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if err := s.store.SetPassword(body.Password); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		s.mu.Lock()
		s.setupCode = ""
		s.mu.Unlock()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	m.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		var n, tokens, passkeys int
		var setup bool
		s.store.Read(func(st *State) {
			n, tokens, passkeys, setup = len(st.Artifacts), len(st.Tokens), len(st.Passkeys), st.PasswordHash == ""
		})
		writeJSON(w, 200, map[string]any{"artifacts": n, "tokens": tokens, "passkeys": passkeys,
			"needsSetup": setup, "setupUrl": s.SetupURL(), "publicUrl": s.cfg.PublicURL, "version": s.cfg.Version})
	})
	srv := &http.Server{Handler: m, ReadHeaderTimeout: 5 * time.Second}
	err = srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
