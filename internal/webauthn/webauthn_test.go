package webauthn

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"testing"
)

type authenticator struct {
	key   *ecdsa.PrivateKey
	id    []byte
	count uint32
}

func newAuthenticator(t *testing.T) *authenticator {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &authenticator{key: k, id: []byte("credential-id-123")}
}

func clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]string{"type": typ, "challenge": challenge, "origin": origin})
	return b
}

func (a *authenticator) authData(rpID string, flags byte, attested bool) []byte {
	h := sha256.Sum256([]byte(rpID))
	out := append([]byte{}, h[:]...)
	out = append(out, flags)
	out = binary.BigEndian.AppendUint32(out, a.count)
	if attested {
		out = append(out, make([]byte, 16)...) // AAGUID
		out = binary.BigEndian.AppendUint16(out, uint16(len(a.id)))
		out = append(out, a.id...)
		pub, _ := a.key.PublicKey.ECDH()
		raw := pub.Bytes() // 0x04 || X || Y
		// COSE_Key map {1:2, 3:-7, -1:1, -2:x, -3:y}
		cose := []byte{0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20}
		cose = append(cose, raw[1:33]...)
		cose = append(cose, 0x22, 0x58, 0x20)
		cose = append(cose, raw[33:]...)
		out = append(out, cose...)
	}
	return out
}

func (a *authenticator) sign(authData, cd []byte) []byte {
	cdh := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, authData...), cdh[:]...))
	sig, _ := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	return sig
}

func TestRegisterAndAssert(t *testing.T) {
	rp := RP{ID: "art.example.com", Origin: "https://art.example.com"}
	a := newAuthenticator(t)
	credID := b64.EncodeToString(a.id)

	cred, err := rp.Register("chal-1", credID, a.authData(rp.ID, 0x45, true), clientData("webauthn.create", "chal-1", rp.Origin))
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	a.count = 5
	ad := a.authData(rp.ID, 0x05, false)
	cd := clientData("webauthn.get", "chal-2", rp.Origin)
	n, err := rp.Assert(*cred, "chal-2", ad, cd, a.sign(ad, cd))
	if err != nil || n != 5 {
		t.Fatalf("assert: n=%d err=%v", n, err)
	}
	cred.SignCount = n

	// Replayed counter is rejected.
	if _, err := rp.Assert(*cred, "chal-2", ad, cd, a.sign(ad, cd)); err == nil {
		t.Fatal("counter replay accepted")
	}
	a.count = 6
	ad = a.authData(rp.ID, 0x05, false)

	cases := map[string]func() error{
		"wrong origin": func() error {
			cd := clientData("webauthn.get", "c", "https://evil.example.com")
			_, err := rp.Assert(*cred, "c", ad, cd, a.sign(ad, cd))
			return err
		},
		"wrong challenge": func() error {
			cd := clientData("webauthn.get", "other", rp.Origin)
			_, err := rp.Assert(*cred, "c", ad, cd, a.sign(ad, cd))
			return err
		},
		"wrong rpId": func() error {
			bad := a.authData("evil.example.com", 0x05, false)
			cd := clientData("webauthn.get", "c", rp.Origin)
			_, err := rp.Assert(*cred, "c", bad, cd, a.sign(bad, cd))
			return err
		},
		"no user verification": func() error {
			bad := a.authData(rp.ID, 0x01, false)
			cd := clientData("webauthn.get", "c", rp.Origin)
			_, err := rp.Assert(*cred, "c", bad, cd, a.sign(bad, cd))
			return err
		},
		"bad signature": func() error {
			cd := clientData("webauthn.get", "c", rp.Origin)
			sig := a.sign(ad, cd)
			sig[len(sig)-1] ^= 1
			_, err := rp.Assert(*cred, "c", ad, cd, sig)
			return err
		},
		"create used for get": func() error {
			cd := clientData("webauthn.create", "c", rp.Origin)
			_, err := rp.Assert(*cred, "c", ad, cd, a.sign(ad, cd))
			return err
		},
	}
	for name, fn := range cases {
		if fn() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRegisterRejectsMismatchedID(t *testing.T) {
	rp := RP{ID: "localhost", Origin: "http://localhost:8080"}
	a := newAuthenticator(t)
	_, err := rp.Register("c", "not-the-id", a.authData(rp.ID, 0x45, true), clientData("webauthn.create", "c", rp.Origin))
	if err == nil {
		t.Fatal("mismatched credential id accepted")
	}
}

func TestDecodeCBORLimits(t *testing.T) {
	for _, in := range [][]byte{{}, {0x5f}, {0x59, 0xff, 0xff}, {0xa1}} {
		if _, _, err := decodeCBOR(in, 0, 0); err == nil {
			t.Errorf("% x: expected error", in)
		}
	}
}
