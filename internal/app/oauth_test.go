package app

import (
	"crypto/sha256"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestMCPOAuthFlow(t *testing.T) {
	e := newEnv(t, Config{PublicURL: "https://art.example.com"})
	host := map[string]string{hostHeader: "art.example.com"}
	with := func(extra map[string]string) map[string]string {
		h := map[string]string{hostHeader: "art.example.com"}
		for k, v := range extra {
			h[k] = v
		}
		return h
	}
	// 1. Discovery: /mcp challenges with the resource metadata URL.
	rec := e.do("POST", "/mcp", strings.NewReader(`{}`), host)
	if rec.Code != 401 || !strings.Contains(rec.Header().Get("WWW-Authenticate"), `resource_metadata="https://art.example.com/.well-known/oauth-protected-resource"`) {
		t.Fatalf("mcp challenge: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	var prm map[string]any
	json.Unmarshal(e.do("GET", "/.well-known/oauth-protected-resource", nil, host).Body.Bytes(), &prm)
	if prm["resource"] != "https://art.example.com/mcp" {
		t.Fatalf("resource metadata: %v", prm)
	}
	var asm map[string]any
	json.Unmarshal(e.do("GET", "/.well-known/oauth-authorization-server", nil, host).Body.Bytes(), &asm)
	if asm["token_endpoint"] != "https://art.example.com/oauth/token" {
		t.Fatalf("server metadata: %v", asm)
	}
	// 2. Dynamic registration.
	if c := e.do("POST", "/oauth/register", strings.NewReader(`{"redirect_uris":["http://evil.example/cb"]}`), with(map[string]string{"Content-Type": "application/json"})).Code; c != 400 {
		t.Fatalf("plain-http redirect accepted: %d", c)
	}
	redirect := "https://claude.ai/api/mcp/auth_callback"
	reg := e.do("POST", "/oauth/register", strings.NewReader(`{"client_name":"Claude","redirect_uris":["`+redirect+`"]}`), with(map[string]string{"Content-Type": "application/json"}))
	var client struct {
		ClientID string `json:"client_id"`
	}
	json.Unmarshal(reg.Body.Bytes(), &client)
	if reg.Code != 201 || client.ClientID == "" {
		t.Fatalf("register: %d %s", reg.Code, reg.Body)
	}
	// 3. Consent, as the signed-in owner.
	login := e.do("POST", "/api/auth/login", strings.NewReader(`{"password":"correct horse battery"}`), with(map[string]string{"Content-Type": "application/json"}))
	ck := login.Result().Cookies()[0]
	owner := with(map[string]string{"Cookie": ck.Name + "=" + ck.Value, "X-Vitryn": "1", "Content-Type": "application/json"})
	verifier := "a-long-random-pkce-verifier-string-0123456789abcdef"
	sum := sha256.Sum256([]byte(verifier))
	decide := func(approve bool, redirectURI string) *httptestResult {
		b, _ := json.Marshal(map[string]any{"client_id": client.ClientID, "redirect_uri": redirectURI, "state": "xyz",
			"code_challenge": b64.EncodeToString(sum[:]), "code_challenge_method": "S256", "response_type": "code", "approve": approve})
		r := e.do("POST", "/api/oauth/authorize", strings.NewReader(string(b)), owner)
		var out struct{ Redirect string }
		json.Unmarshal(r.Body.Bytes(), &out)
		return &httptestResult{r.Code, out.Redirect}
	}
	if r := decide(true, "https://evil.example/cb"); r.code != 400 {
		t.Fatalf("unregistered redirect: %d", r.code)
	}
	if r := decide(false, redirect); !strings.Contains(r.redirect, "error=access_denied") || !strings.Contains(r.redirect, "state=xyz") {
		t.Fatalf("deny: %s", r.redirect)
	}
	if c := e.do("POST", "/api/oauth/authorize", strings.NewReader(`{}`), with(map[string]string{"Content-Type": "application/json"})).Code; c != 401 {
		t.Fatalf("consent without session: %d", c)
	}
	ok := decide(true, redirect)
	u, _ := url.Parse(ok.redirect)
	code := u.Query().Get("code")
	if code == "" || u.Query().Get("state") != "xyz" {
		t.Fatalf("approve: %s", ok.redirect)
	}
	// 4. Token exchange (PKCE).
	token := func(form url.Values) (int, map[string]any) {
		r := e.do("POST", "/oauth/token", strings.NewReader(form.Encode()), with(map[string]string{"Content-Type": "application/x-www-form-urlencoded"}))
		var m map[string]any
		json.Unmarshal(r.Body.Bytes(), &m)
		return r.Code, m
	}
	exchange := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {client.ClientID}, "redirect_uri": {redirect}}
	bad := url.Values{}
	for k, v := range exchange {
		bad[k] = v
	}
	bad.Set("code_verifier", "wrong")
	if c, _ := token(bad); c != 400 {
		t.Fatalf("bad verifier: %d", c)
	}
	// The failed attempt burned the code; get a fresh one.
	u, _ = url.Parse(decide(true, redirect).redirect)
	exchange.Set("code", u.Query().Get("code"))
	exchange.Set("code_verifier", verifier)
	c, tok := token(exchange)
	if c != 200 || tok["access_token"] == nil || tok["refresh_token"] == nil {
		t.Fatalf("exchange: %d %v", c, tok)
	}
	if c, _ := token(exchange); c != 400 {
		t.Fatalf("code reused: %d", c)
	}
	// 5. The access token works for MCP.
	call := func(access string) int {
		return e.do("POST", "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`),
			with(map[string]string{"Authorization": "Bearer " + access, "Content-Type": "application/json"})).Code
	}
	if c := call(tok["access_token"].(string)); c != 200 {
		t.Fatalf("mcp with OAuth token: %d", c)
	}
	// 6. Refresh rotates; the old refresh token stops working.
	c, tok2 := token(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {client.ClientID}})
	if c != 200 || tok2["access_token"] == tok["access_token"] {
		t.Fatalf("refresh: %d", c)
	}
	if c, _ := token(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok["refresh_token"].(string)}, "client_id": {client.ClientID}}); c != 400 {
		t.Fatalf("old refresh token reused: %d", c)
	}
	if c := call(tok["access_token"].(string)); c != 401 {
		t.Fatalf("rotated-out access token still works: %d", c)
	}
	if c := call(tok2["access_token"].(string)); c != 200 {
		t.Fatalf("new access token: %d", c)
	}
	// 7. CORS preflight for browser clients.
	if r := e.do("OPTIONS", "/oauth/token", nil, host); r.Code != 204 || r.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("preflight: %d", r.Code)
	}
}

type httptestResult struct {
	code     int
	redirect string
}
