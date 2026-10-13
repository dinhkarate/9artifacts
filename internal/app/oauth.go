package app

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// OAuth 2.1 authorization server for MCP clients (claude.ai and ChatGPT
// connectors, MCP Inspector…), following the MCP authorization spec:
// protected-resource metadata (RFC 9728), server metadata (RFC 8414),
// dynamic client registration (RFC 7591), PKCE S256 only, public clients.
// The owner approves a client on a consent page while signed in; the client
// then gets an access token (1 h) and a rotating refresh token (90 days),
// both stored hashed and revocable in Settings like any API token.

const (
	oauthCodeTTL    = 5 * time.Minute
	oauthAccessTTL  = time.Hour
	oauthRefreshTTL = 90 * 24 * time.Hour
	maxOAuthClients = 100
)

type oauthCode struct {
	clientID, redirectURI, challenge string
	expires                          time.Time
}

func (s *Server) resourceURL() string { return s.cfg.PublicURL + "/mcp" }

func (s *Server) resourceMetadataURL() string {
	return s.cfg.PublicURL + "/.well-known/oauth-protected-resource"
}

func (s *Server) handleResourceMetadata(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"resource":                 s.resourceURL(),
		"authorization_servers":    []string{s.cfg.PublicURL},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"mcp"},
		"resource_name":            s.cfg.Name,
	})
}

func (s *Server) handleAuthServerMetadata(w http.ResponseWriter, r *http.Request) {
	u := s.cfg.PublicURL
	writeJSON(w, 200, map[string]any{
		"issuer":                                u,
		"authorization_endpoint":                u + "/oauth/authorize",
		"token_endpoint":                        u + "/oauth/token",
		"registration_endpoint":                 u + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      []string{"mcp"},
	})
}

func oauthError(w http.ResponseWriter, status int, code, desc string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

// validRedirect accepts https URLs and http loopback URLs (native apps).
func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.Host == "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1" || h == "::1"
	}
	return false
}

func (s *Server) handleOAuthRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := readJSON(r, &body); err != nil {
		oauthError(w, 400, "invalid_client_metadata", "invalid JSON")
		return
	}
	if len(body.RedirectURIs) == 0 || len(body.RedirectURIs) > 10 {
		oauthError(w, 400, "invalid_redirect_uri", "1 to 10 redirect_uris are required")
		return
	}
	for _, u := range body.RedirectURIs {
		if !validRedirect(u) || len(u) > 2000 {
			oauthError(w, 400, "invalid_redirect_uri", "redirect URIs must be https (or http on localhost)")
			return
		}
	}
	name := truncate(strings.TrimSpace(body.ClientName), 80)
	if name == "" {
		name = "MCP client"
	}
	c := &OAuthClient{ID: "vc_" + newID(12), Name: name, RedirectURIs: body.RedirectURIs, CreatedAt: time.Now().UTC()}
	_ = s.store.Update(func(st *State) error {
		if st.OAuthClients == nil {
			st.OAuthClients = map[string]*OAuthClient{}
		}
		if len(st.OAuthClients) >= maxOAuthClients {
			// Forget the oldest client that has no token.
			var oldest *OAuthClient
			for _, x := range st.OAuthClients {
				used := slices.ContainsFunc(st.Tokens, func(t Token) bool { return t.ClientID == x.ID })
				if !used && (oldest == nil || x.CreatedAt.Before(oldest.CreatedAt)) {
					oldest = x
				}
			}
			if oldest != nil {
				delete(st.OAuthClients, oldest.ID)
			}
		}
		st.OAuthClients[c.ID] = c
		return nil
	})
	writeJSON(w, 201, map[string]any{
		"client_id": c.ID, "client_id_issued_at": c.CreatedAt.Unix(), "client_name": c.Name,
		"redirect_uris": c.RedirectURIs, "token_endpoint_auth_method": "none",
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
	})
}

func (s *Server) oauthClient(id string) *OAuthClient {
	var c *OAuthClient
	s.store.Read(func(st *State) {
		if x := st.OAuthClients[id]; x != nil {
			cp := *x
			c = &cp
		}
	})
	return c
}

// handleOAuthClientInfo feeds the consent page (owner session only).
func (s *Server) handleOAuthClientInfo(w http.ResponseWriter, r *http.Request) {
	c := s.oauthClient(r.URL.Query().Get("client_id"))
	redirect := r.URL.Query().Get("redirect_uri")
	if c == nil || !slices.Contains(c.RedirectURIs, redirect) {
		writeError(w, 400, "unknown client or redirect URI")
		return
	}
	u, _ := url.Parse(redirect)
	writeJSON(w, 200, map[string]string{"name": c.Name, "redirectHost": u.Host})
}

// handleOAuthDecision is the consent page's Allow/Deny (owner session + CSRF).
func (s *Server) handleOAuthDecision(w http.ResponseWriter, r *http.Request) {
	var b struct {
		ClientID     string `json:"client_id"`
		RedirectURI  string `json:"redirect_uri"`
		State        string `json:"state"`
		Challenge    string `json:"code_challenge"`
		Method       string `json:"code_challenge_method"`
		ResponseType string `json:"response_type"`
		Resource     string `json:"resource"`
		Approve      bool   `json:"approve"`
	}
	if err := readJSON(r, &b); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	c := s.oauthClient(b.ClientID)
	if c == nil || !slices.Contains(c.RedirectURIs, b.RedirectURI) {
		// Never redirect to an unregistered URI.
		writeError(w, 400, "unknown client or redirect URI")
		return
	}
	back := func(params url.Values) {
		if b.State != "" {
			params.Set("state", b.State)
		}
		params.Set("iss", s.cfg.PublicURL)
		u, _ := url.Parse(b.RedirectURI)
		q := u.Query()
		for k, v := range params {
			q[k] = v
		}
		u.RawQuery = q.Encode()
		writeJSON(w, 200, map[string]string{"redirect": u.String()})
	}
	switch {
	case !b.Approve:
		back(url.Values{"error": {"access_denied"}})
		return
	case b.ResponseType != "code":
		back(url.Values{"error": {"unsupported_response_type"}})
		return
	case b.Method != "S256" || len(b.Challenge) < 43 || len(b.Challenge) > 128:
		back(url.Values{"error": {"invalid_request"}, "error_description": {"PKCE with S256 is required"}})
		return
	case b.Resource != "" && strings.TrimRight(b.Resource, "/") != s.resourceURL() && strings.TrimRight(b.Resource, "/") != s.cfg.PublicURL:
		back(url.Values{"error": {"invalid_target"}})
		return
	}
	code := b64.EncodeToString(randomBytes(24))
	s.mu.Lock()
	now := time.Now()
	for k, v := range s.codes {
		if now.After(v.expires) {
			delete(s.codes, k)
		}
	}
	if len(s.codes) < 1000 {
		s.codes[hashSecret(code)] = oauthCode{clientID: c.ID, redirectURI: b.RedirectURI, challenge: b.Challenge, expires: now.Add(oauthCodeTTL)}
	}
	s.mu.Unlock()
	back(url.Values{"code": {code}})
}

func (s *Server) handleOAuthToken(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		oauthError(w, 400, "invalid_request", "form body expected")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		s.exchangeCode(w, r)
	case "refresh_token":
		s.refreshToken(w, r)
	default:
		oauthError(w, 400, "unsupported_grant_type", "use authorization_code or refresh_token")
	}
}

func (s *Server) exchangeCode(w http.ResponseWriter, r *http.Request) {
	f := r.PostForm
	key := hashSecret(f.Get("code"))
	s.mu.Lock()
	c, ok := s.codes[key]
	delete(s.codes, key) // single use, even when the rest fails
	s.mu.Unlock()
	if !ok || time.Now().After(c.expires) || c.clientID != f.Get("client_id") || c.redirectURI != f.Get("redirect_uri") {
		oauthError(w, 400, "invalid_grant", "unknown, expired or mismatched code")
		return
	}
	sum := sha256.Sum256([]byte(f.Get("code_verifier")))
	if subtle.ConstantTimeCompare([]byte(b64.EncodeToString(sum[:])), []byte(c.challenge)) != 1 {
		oauthError(w, 400, "invalid_grant", "PKCE verification failed")
		return
	}
	client := s.oauthClient(c.clientID)
	if client == nil {
		oauthError(w, 400, "invalid_client", "client no longer registered")
		return
	}
	s.issueTokens(w, client, "")
}

func (s *Server) refreshToken(w http.ResponseWriter, r *http.Request) {
	f := r.PostForm
	want := hashSecret(f.Get("refresh_token"))
	var client *OAuthClient
	s.store.Read(func(st *State) {
		for _, t := range st.Tokens {
			if t.RefreshHash != "" && subtle.ConstantTimeCompare([]byte(t.RefreshHash), []byte(want)) == 1 &&
				t.RefreshExpiresAt != nil && time.Now().Before(*t.RefreshExpiresAt) && t.ClientID == f.Get("client_id") {
				if x := st.OAuthClients[t.ClientID]; x != nil {
					cp := *x
					client = &cp
				}
			}
		}
	})
	if client == nil {
		oauthError(w, 400, "invalid_grant", "unknown or expired refresh token")
		return
	}
	s.issueTokens(w, client, want)
}

// issueTokens creates (or rotates) the one token record a client has.
func (s *Server) issueTokens(w http.ResponseWriter, c *OAuthClient, oldRefresh string) {
	access := "vt_" + b64.EncodeToString(randomBytes(24))
	refresh := "vr_" + b64.EncodeToString(randomBytes(32))
	now := time.Now().UTC()
	exp, rexp := now.Add(oauthAccessTTL), now.Add(oauthRefreshTTL)
	err := s.store.Update(func(st *State) error {
		i := slices.IndexFunc(st.Tokens, func(t Token) bool { return t.ClientID == c.ID })
		if oldRefresh != "" && (i < 0 || st.Tokens[i].RefreshHash != oldRefresh) {
			return errors.New("refresh token was already used")
		}
		t := Token{ID: newID(5), Name: c.Name + " (OAuth)", CreatedAt: now}
		if i >= 0 {
			t = st.Tokens[i]
		} else if len(st.Tokens) >= 50 {
			return errors.New("too many tokens; delete some in Settings")
		}
		t.Hash, t.Prefix, t.ExpiresAt = hashSecret(access), access[:7], &exp
		t.ClientID, t.RefreshHash, t.RefreshExpiresAt = c.ID, hashSecret(refresh), &rexp
		if i >= 0 {
			st.Tokens[i] = t
		} else {
			st.Tokens = append(st.Tokens, t)
		}
		return nil
	})
	if err != nil {
		oauthError(w, 400, "invalid_grant", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(oauthAccessTTL.Seconds()),
		"refresh_token": refresh, "scope": "mcp"})
}

// cors lets browser-based MCP clients (MCP Inspector, web IDEs) call the
// public OAuth endpoints and /mcp. No cookies are involved.
func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}
