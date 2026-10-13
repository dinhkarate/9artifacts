package app

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// cfAccess verifies the JWT Cloudflare Access adds to every request it lets
// through (Cf-Access-Jwt-Assertion), so the app host stays closed even if an
// Access policy is missing or the origin is reached around Cloudflare.
type cfAccess struct {
	team string // https://<team>.cloudflareaccess.com
	aud  string // the Access application's AUD tag

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
	client  *http.Client
}

func newCFAccess(team, aud string) (*cfAccess, error) {
	team = strings.TrimRight(team, "/")
	if !strings.HasPrefix(team, "https://") || aud == "" {
		return nil, errors.New("Cloudflare Access needs --cf-access-team https://<team>.cloudflareaccess.com and --cf-access-aud <AUD tag>")
	}
	return &cfAccess{team: team, aud: aud, client: &http.Client{Timeout: 10 * time.Second}}, nil
}

func (c *cfAccess) verify(token string) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return errors.New("missing Access token")
	}
	var head struct{ Alg, Kid string }
	if err := decodeSegment(parts[0], &head); err != nil || head.Alg != "RS256" {
		return errors.New("unsupported Access token")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return errors.New("bad Access token signature")
	}
	key, err := c.key(head.Kid)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) != nil {
		return errors.New("bad Access token signature")
	}
	var claims struct {
		Iss string          `json:"iss"`
		Aud json.RawMessage `json:"aud"`
		Exp int64           `json:"exp"`
		Nbf int64           `json:"nbf"`
	}
	if err := decodeSegment(parts[1], &claims); err != nil {
		return errors.New("bad Access token claims")
	}
	now := time.Now().Unix()
	var auds []string
	if json.Unmarshal(claims.Aud, &auds) != nil {
		var one string
		_ = json.Unmarshal(claims.Aud, &one)
		auds = []string{one}
	}
	switch {
	case claims.Iss != c.team:
		return errors.New("Access token from another team")
	case !slices.Contains(auds, c.aud):
		return errors.New("Access token for another application")
	case claims.Exp == 0 || now > claims.Exp+30:
		return errors.New("Access token expired")
	case claims.Nbf != 0 && now+30 < claims.Nbf:
		return errors.New("Access token not valid yet")
	}
	return nil
}

func decodeSegment(seg string, v any) error {
	b, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// key returns the signing key for kid, refreshing the team's key set when
// the kid is unknown (Cloudflare rotates keys) at most every 30 seconds.
func (c *cfAccess) key(kid string) (*rsa.PublicKey, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if k := c.keys[kid]; k != nil && time.Since(c.fetched) < 24*time.Hour {
		return k, nil
	}
	if time.Since(c.fetched) > 30*time.Second {
		if keys, err := c.fetch(); err == nil {
			c.keys, c.fetched = keys, time.Now()
		} else if c.keys == nil {
			return nil, err
		}
	}
	if k := c.keys[kid]; k != nil {
		return k, nil
	}
	return nil, errors.New("unknown Access signing key")
}

func (c *cfAccess) fetch() (map[string]*rsa.PublicKey, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", c.team+"/cdn-cgi/access/certs", nil)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch Access keys: %w", err)
	}
	defer resp.Body.Close()
	var set struct {
		Keys []struct{ Kid, Kty, N, E string }
	}
	if resp.StatusCode != 200 || json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&set) != nil {
		return nil, fmt.Errorf("fetch Access keys: HTTP %d", resp.StatusCode)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if k.Kty != "RSA" || err1 != nil || err2 != nil || len(e) > 4 {
			continue
		}
		pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
		if pub.N.BitLen() < 2048 || pub.E < 3 {
			continue
		}
		keys[k.Kid] = pub
	}
	if len(keys) == 0 {
		return nil, errors.New("fetch Access keys: no RSA keys")
	}
	return keys, nil
}
