package app

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCloudflareAccess(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	b64u := base64.RawURLEncoding
	var team string
	certs := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"kid": "k1", "kty": "RSA",
			"n": b64u.EncodeToString(key.N.Bytes()), "e": b64u.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	}))
	defer certs.Close()
	team = certs.URL
	sign := func(claims map[string]any, kid string) string {
		h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid})
		c, _ := json.Marshal(claims)
		in := b64u.EncodeToString(h) + "." + b64u.EncodeToString(c)
		d := sha256.Sum256([]byte(in))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, d[:])
		return in + "." + b64u.EncodeToString(sig)
	}
	exp := time.Now().Add(time.Hour).Unix()
	good := map[string]any{"iss": team, "aud": []string{"app-aud"}, "exp": exp, "email": "owner@example.com"}

	e := newEnv(t, Config{CFAccessTeam: team, CFAccessAUD: "app-aud"})
	e.srv.access.client = certs.Client()
	get := func(path, jwt string, extra map[string]string) int {
		h := map[string]string{"Cf-Access-Jwt-Assertion": jwt}
		for k, v := range extra {
			h[k] = v
		}
		return e.do("GET", path, nil, h).Code
	}
	if c := get("/", sign(good, "k1"), nil); c != 200 {
		t.Fatalf("valid Access JWT: %d", c)
	}
	bad := map[string]string{
		"missing":       "",
		"wrong aud":     sign(map[string]any{"iss": team, "aud": "other", "exp": exp}, "k1"),
		"wrong team":    sign(map[string]any{"iss": "https://evil.cloudflareaccess.com", "aud": "app-aud", "exp": exp}, "k1"),
		"expired":       sign(map[string]any{"iss": team, "aud": "app-aud", "exp": time.Now().Add(-time.Hour).Unix()}, "k1"),
		"unknown kid":   sign(good, "k2"),
		"tampered body": strings.Replace(sign(good, "k1"), ".", ".e30", 1),
	}
	for name, jwt := range bad {
		if c := get("/", jwt, nil); c != 403 {
			t.Errorf("%s: got %d, want 403", name, c)
		}
	}
	// Agents with a valid API token, share links and health checks skip Access.
	if c := get("/api/artifacts", "", map[string]string{"Authorization": "Bearer " + e.token}); c != 200 {
		t.Errorf("API token without Access: %d", c)
	}
	if c := get("/api/artifacts", "", map[string]string{"Authorization": "Bearer vt_bogus"}); c != 403 {
		t.Errorf("bogus API token skipped Access: %d", c)
	}
	if c := get("/health", "", nil); c != 200 {
		t.Errorf("health behind Access: %d", c)
	}
	if c := get("/s/nope", "", nil); c != 404 {
		t.Errorf("share page behind Access: %d", c)
	}
	st, _ := OpenStore(t.TempDir())
	if _, err := New(Config{CFAccessTeam: team}, st); err == nil {
		t.Error("Access team without AUD accepted")
	}
}
