package app

import (
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// AdminSocketPath is the Unix socket the running server exposes for local
// administration. Access is controlled by filesystem permissions (0600),
// so anyone who can read the data directory is already the owner.
func AdminSocketPath(dataDir string) string { return filepath.Join(dataDir, "admin.sock") }

// ServeAdmin listens on the admin socket until the listener fails.
func (s *Server) ServeAdmin() error {
	sock := AdminSocketPath(s.store.dir)
	if len(sock) > 100 {
		return errors.New("data directory path too long for the admin socket (" + sock + "); use a shorter --data path to enable glasshelf token/passwd/status")
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
