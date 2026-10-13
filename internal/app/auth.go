package app

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/dinhkarate/vitrine/internal/webauthn"
)

// pbkdf2Iter is a variable only so tests can lower it; the count is stored
// in each hash, so changing it never invalidates existing passwords.
var pbkdf2Iter = 600_000

const (
	failLimit       = 5
	globalFailLimit = 50
	failWindow      = 15 * time.Minute
	lockDuration    = 15 * time.Minute
	challengeTTL    = 5 * time.Minute
	minPasswordSize = 10
)

var b64 = base64.RawURLEncoding

// ---------- passwords ----------

func hashPassword(pw string) string {
	salt := randomBytes(16)
	key, _ := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Iter, 32)
	return "pbkdf2-sha256$" + strconv.Itoa(pbkdf2Iter) + "$" + b64.EncodeToString(salt) + "$" + b64.EncodeToString(key)
}

func checkPassword(pw, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err1 := b64.DecodeString(parts[2])
	want, err2 := b64.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

// SetPassword replaces the owner password and signs out every session.
func (st *Store) SetPassword(pw string) error {
	if len(pw) < minPasswordSize {
		return errors.New("password must be at least 10 characters")
	}
	h := hashPassword(pw)
	return st.Update(func(s *State) error {
		s.PasswordHash = h
		s.Sessions = map[string]time.Time{}
		return nil
	})
}

// ---------- sessions and tokens ----------

func hashSecret(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func (s *Server) startSession(w http.ResponseWriter) error {
	sid := b64.EncodeToString(randomBytes(32))
	err := s.store.Update(func(st *State) error {
		st.Sessions[hashSecret(sid)] = time.Now().Add(sessionTTL)
		return nil
	})
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: s.cookieName(), Value: sid, Path: "/", HttpOnly: true,
		Secure: strings.HasPrefix(s.cfg.PublicURL, "https://"), SameSite: http.SameSiteStrictMode,
		MaxAge: int(sessionTTL.Seconds()),
	})
	return nil
}

// cookieName uses the __Host- prefix on HTTPS so a sibling subdomain (for
// example the content origin) can never plant or overwrite the session.
func (s *Server) cookieName() string {
	if strings.HasPrefix(s.cfg.PublicURL, "https://") {
		return "__Host-" + sessionCookie
	}
	return sessionCookie
}

func (s *Server) hasSession(r *http.Request) bool {
	c, err := r.Cookie(s.cookieName())
	if err != nil || c.Value == "" {
		return false
	}
	ok := false
	s.store.Read(func(st *State) {
		exp, found := st.Sessions[hashSecret(c.Value)]
		ok = found && time.Now().Before(exp)
	})
	return ok
}

// CreateToken issues a new API token and returns its plaintext once.
func (st *Store) CreateToken(name string) (string, Token, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "token"
	}
	if len(name) > 60 {
		name = name[:60]
	}
	secret := "vt_" + b64.EncodeToString(randomBytes(24))
	t := Token{ID: newID(5), Name: name, Hash: hashSecret(secret), Prefix: secret[:7], CreatedAt: time.Now().UTC()}
	err := st.Update(func(s *State) error {
		if len(s.Tokens) >= 50 {
			return errors.New("too many tokens; delete some first")
		}
		s.Tokens = append(s.Tokens, t)
		return nil
	})
	return secret, t, err
}

// tokenAuth validates an "Authorization: Bearer vt_..." header.
// tokenName returns the name of the API token on the request, or "".
func (s *Server) tokenName(r *http.Request) string {
	secret, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !strings.HasPrefix(secret, "vt_") {
		return ""
	}
	want := hashSecret(strings.TrimSpace(secret))
	name := ""
	s.store.Read(func(st *State) {
		for _, t := range st.Tokens {
			if subtle.ConstantTimeCompare([]byte(t.Hash), []byte(want)) == 1 {
				name = t.Name
			}
		}
	})
	return name
}

func (s *Server) tokenAuth(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	secret, ok := strings.CutPrefix(h, "Bearer ")
	if !ok || !strings.HasPrefix(secret, "vt_") {
		return false
	}
	want := hashSecret(strings.TrimSpace(secret))
	found, stale := false, false
	now := time.Now().UTC()
	s.store.Read(func(st *State) {
		for _, t := range st.Tokens {
			if subtle.ConstantTimeCompare([]byte(t.Hash), []byte(want)) == 1 {
				found = true
				stale = t.LastUsedAt == nil || now.Sub(*t.LastUsedAt) > time.Minute
			}
		}
	})
	if found && stale {
		_ = s.store.Update(func(st *State) error {
			for i := range st.Tokens {
				if st.Tokens[i].Hash == want {
					st.Tokens[i].LastUsedAt = &now
				}
			}
			return nil
		})
	}
	return found
}

// csrfOK: cookie-authenticated writes must come from our own JavaScript,
// which always sends this header; forms from other sites cannot.
func csrfOK(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	return r.Header.Get("X-Vitrine") == "1"
}

// auth accepts an API token or a browser session.
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.tokenAuth(r) || (s.hasSession(r) && csrfOK(r)) {
			next(w, r)
			return
		}
		writeError(w, 401, "authentication required")
	}
}

// session accepts only a browser session (account management).
func (s *Server) session(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.hasSession(r) && csrfOK(r) {
			next(w, r)
			return
		}
		writeError(w, 401, "authentication required")
	}
}

// ---------- rate limiting ----------

func (s *Server) locked(ip string) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f := s.failures[ip]; f != nil && time.Now().Before(f.lock) {
		return time.Until(f.lock)
	}
	return 0
}

// passwordLocked also applies the global cap, so rotating addresses does
// not buy unlimited guesses. Passkey sign-in is never globally locked.
func (s *Server) passwordLocked(ip string) time.Duration {
	if d := s.locked(ip); d > 0 {
		return d
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Now().Before(s.global.lock) {
		return time.Until(s.global.lock)
	}
	return 0
}

// allowBegin rate-limits unauthenticated passkey ceremonies per address.
func (s *Server) allowBegin(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	b := s.begins[ip]
	if b == nil || now.Sub(b.first) > time.Minute {
		if len(s.begins) > 10000 {
			clear(s.begins)
		}
		b = &failure{first: now}
		s.begins[ip] = b
	}
	b.count++
	return b.count <= 20
}

// fail records a failed attempt for ip. Only password guesses count
// towards the global cap, so nobody can lock the owner out by spamming
// setup codes or bogus passkeys.
func (s *Server) fail(ip string) { s.recordFailure(ip, false) }

func (s *Server) failPassword(ip string) { s.recordFailure(ip, true) }

func (s *Server) recordFailure(ip string, password bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	f := s.failures[ip]
	if f == nil || now.Sub(f.first) > failWindow {
		f = &failure{first: now}
		s.failures[ip] = f
	}
	f.count++
	if f.count >= failLimit {
		f.lock = now.Add(lockDuration)
		f.count = 0
		f.first = now
	}
	if !password {
		return
	}
	if now.Sub(s.global.first) > failWindow {
		s.global = failure{first: now, lock: s.global.lock}
	}
	s.global.count++
	if s.global.count >= globalFailLimit {
		s.global.lock = now.Add(lockDuration)
		s.global.count = 0
		s.global.first = now
	}
	if len(s.failures) > 10000 {
		for k, v := range s.failures {
			if now.Sub(v.first) > failWindow && now.After(v.lock) {
				delete(s.failures, k)
			}
		}
	}
}

func tooMany(w http.ResponseWriter, wait time.Duration) {
	secs := int(wait.Seconds()) + 1
	w.Header().Set("Retry-After", strconv.Itoa(secs))
	writeJSON(w, 429, map[string]any{"error": "too many failed attempts, try again later", "retryAfter": secs})
}

// ---------- handlers ----------

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	var needsSetup bool
	var passkeys int
	s.store.Read(func(st *State) { needsSetup, passkeys = st.PasswordHash == "", len(st.Passkeys) })
	authed := s.hasSession(r) || s.tokenAuth(r)
	writeJSON(w, 200, map[string]any{
		"authenticated": authed, "needsSetup": needsSetup, "hasPasskeys": passkeys > 0,
		"name": s.cfg.Name, "version": s.cfg.Version, "publicUrl": s.cfg.PublicURL,
		"contentOrigin": s.contentOrigin(), "separateContentOrigin": s.contHost != "",
	})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.passwordLocked(ip); wait > 0 {
		tooMany(w, wait)
		return
	}
	var body struct{ Code, Password string }
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	code := s.setupCode
	s.mu.Unlock()
	if code == "" {
		writeError(w, 409, "setup already completed")
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Code), []byte(code)) != 1 {
		s.fail(ip)
		writeError(w, 403, "wrong setup code (see the server log)")
		return
	}
	if err := s.store.SetPassword(body.Password); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	s.setupCode = ""
	s.mu.Unlock()
	if err := s.startSession(w); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, map[string]bool{"ok": true})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.passwordLocked(ip); wait > 0 {
		tooMany(w, wait)
		return
	}
	var body struct{ Password string }
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	var hash string
	s.store.Read(func(st *State) { hash = st.PasswordHash })
	if hash == "" {
		writeError(w, 409, "setup required")
		return
	}
	if !checkPassword(body.Password, hash) {
		s.failPassword(ip)
		if wait := s.passwordLocked(ip); wait > 0 {
			tooMany(w, wait)
			return
		}
		writeError(w, 401, "wrong password")
		return
	}
	if err := s.startSession(w); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(s.cookieName()); err == nil {
		_ = s.store.Update(func(st *State) error {
			delete(st.Sessions, hashSecret(c.Value))
			return nil
		})
	}
	http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		Secure: strings.HasPrefix(s.cfg.PublicURL, "https://"), SameSite: http.SameSiteStrictMode})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handlePasswordChange(w http.ResponseWriter, r *http.Request) {
	var body struct{ Current, Password string }
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	ip := s.clientIP(r)
	if wait := s.passwordLocked(ip); wait > 0 {
		tooMany(w, wait)
		return
	}
	var hash string
	s.store.Read(func(st *State) { hash = st.PasswordHash })
	if !checkPassword(body.Current, hash) {
		s.failPassword(ip)
		writeError(w, 403, "current password is wrong")
		return
	}
	if err := s.store.SetPassword(body.Password); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if err := s.startSession(w); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---------- passkeys ----------

func (s *Server) newChallenge(kind string) (id, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, c := range s.challenges {
		if now.After(c.expires) {
			delete(s.challenges, k)
		}
	}
	id, value = newID(10), b64.EncodeToString(randomBytes(32))
	if len(s.challenges) >= 1000 {
		var oldest string
		for k, c := range s.challenges {
			if oldest == "" || c.expires.Before(s.challenges[oldest].expires) {
				oldest = k
			}
		}
		delete(s.challenges, oldest)
	}
	s.challenges[id] = challenge{kind: kind, value: value, expires: now.Add(challengeTTL)}
	return id, value
}

func (s *Server) takeChallenge(id, kind string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.challenges[id]
	delete(s.challenges, id)
	if !ok || c.kind != kind || time.Now().After(c.expires) {
		return "", false
	}
	return c.value, true
}

func (s *Server) userHandle() string {
	m := hmac.New(sha256.New, s.signKey)
	m.Write([]byte("webauthn-user"))
	return b64.EncodeToString(m.Sum(nil)[:16])
}

func (s *Server) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	id, ch := s.newChallenge("register")
	var exclude []map[string]string
	s.store.Read(func(st *State) {
		for _, p := range st.Passkeys {
			exclude = append(exclude, map[string]string{"type": "public-key", "id": p.ID})
		}
	})
	writeJSON(w, 200, map[string]any{
		"challengeId": id, "challenge": ch,
		"rp":                     map[string]string{"id": s.rp.ID, "name": s.cfg.Name},
		"user":                   map[string]string{"id": s.userHandle(), "name": "owner", "displayName": s.cfg.Name + " owner"},
		"pubKeyCredParams":       []map[string]any{{"type": "public-key", "alg": -7}},
		"excludeCredentials":     exclude,
		"authenticatorSelection": map[string]string{"residentKey": "preferred", "userVerification": "required"},
		"attestation":            "none",
	})
}

type passkeyBody struct {
	ChallengeID       string `json:"challengeId"`
	CredentialID      string `json:"credentialId"`
	AuthenticatorData string `json:"authenticatorData"`
	ClientDataJSON    string `json:"clientDataJSON"`
	Signature         string `json:"signature"`
	Name              string `json:"name"`
}

func (s *Server) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	var body passkeyBody
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	ch, ok := s.takeChallenge(body.ChallengeID, "register")
	if !ok {
		writeError(w, 400, "challenge expired, try again")
		return
	}
	authData, err1 := webauthn.Decode(body.AuthenticatorData)
	clientData, err2 := webauthn.Decode(body.ClientDataJSON)
	if err1 != nil || err2 != nil {
		writeError(w, 400, "malformed passkey response")
		return
	}
	cred, err := s.rp.Register(ch, body.CredentialID, authData, clientData)
	if err != nil {
		writeError(w, 400, "passkey registration failed: "+err.Error())
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "Passkey"
	}
	if len(name) > 60 {
		name = name[:60]
	}
	err = s.store.Update(func(st *State) error {
		if slices.ContainsFunc(st.Passkeys, func(p Passkey) bool { return p.ID == cred.ID }) {
			return errors.New("this passkey is already registered")
		}
		st.Passkeys = append(st.Passkeys, Passkey{Credential: *cred, Name: name, CreatedAt: time.Now().UTC()})
		return nil
	})
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"ok": true, "id": cred.ID})
}

func (s *Server) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.locked(ip); wait > 0 {
		tooMany(w, wait)
		return
	}
	if !s.allowBegin(ip) {
		tooMany(w, time.Minute)
		return
	}
	id, ch := s.newChallenge("login")
	allow := []map[string]string{}
	s.store.Read(func(st *State) {
		for _, p := range st.Passkeys {
			allow = append(allow, map[string]string{"type": "public-key", "id": p.ID})
		}
	})
	writeJSON(w, 200, map[string]any{"challengeId": id, "challenge": ch, "rpId": s.rp.ID,
		"allowCredentials": allow, "userVerification": "required"})
}

func (s *Server) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if wait := s.locked(ip); wait > 0 {
		tooMany(w, wait)
		return
	}
	var body passkeyBody
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	ch, ok := s.takeChallenge(body.ChallengeID, "login")
	if !ok {
		writeError(w, 400, "challenge expired, try again")
		return
	}
	var cred *Passkey
	s.store.Read(func(st *State) {
		for _, p := range st.Passkeys {
			if p.ID == body.CredentialID {
				c := p
				cred = &c
			}
		}
	})
	if cred == nil {
		s.fail(ip)
		writeError(w, 401, "unknown passkey")
		return
	}
	authData, err1 := webauthn.Decode(body.AuthenticatorData)
	clientData, err2 := webauthn.Decode(body.ClientDataJSON)
	sig, err3 := webauthn.Decode(body.Signature)
	if err1 != nil || err2 != nil || err3 != nil {
		writeError(w, 400, "malformed passkey response")
		return
	}
	count, err := s.rp.Assert(cred.Credential, ch, authData, clientData, sig)
	if err != nil {
		s.fail(ip)
		writeError(w, 401, "passkey verification failed: "+err.Error())
		return
	}
	_ = s.store.Update(func(st *State) error {
		for i := range st.Passkeys {
			if st.Passkeys[i].ID == cred.ID && count > st.Passkeys[i].SignCount {
				st.Passkeys[i].SignCount = count
			}
		}
		return nil
	})
	if err := s.startSession(w); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handlePasskeyList(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	s.store.Read(func(st *State) {
		for _, p := range st.Passkeys {
			out = append(out, map[string]any{"id": p.ID, "name": p.Name, "createdAt": p.CreatedAt})
		}
	})
	writeJSON(w, 200, out)
}

func (s *Server) handlePasskeyDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.store.Update(func(st *State) error {
		n := len(st.Passkeys)
		st.Passkeys = slices.DeleteFunc(st.Passkeys, func(p Passkey) bool { return p.ID == id })
		if len(st.Passkeys) == n {
			return errors.New("passkey not found")
		}
		return nil
	})
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---------- API tokens ----------

func (s *Server) handleTokenList(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	s.store.Read(func(st *State) {
		for _, t := range st.Tokens {
			out = append(out, map[string]any{"id": t.ID, "name": t.Name, "prefix": t.Prefix, "createdAt": t.CreatedAt, "lastUsedAt": t.LastUsedAt})
		}
	})
	writeJSON(w, 200, out)
}

func (s *Server) handleTokenCreate(w http.ResponseWriter, r *http.Request) {
	var body struct{ Name string }
	if err := readJSON(r, &body); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	secret, t, err := s.store.CreateToken(body.Name)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"id": t.ID, "name": t.Name, "token": secret})
}

func (s *Server) handleTokenDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	err := s.store.Update(func(st *State) error {
		n := len(st.Tokens)
		st.Tokens = slices.DeleteFunc(st.Tokens, func(t Token) bool { return t.ID == id })
		if len(st.Tokens) == n {
			return errors.New("token not found")
		}
		return nil
	})
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
