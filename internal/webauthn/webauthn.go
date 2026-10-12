// Package webauthn verifies passkey registration and assertion ceremonies
// for a single relying party. It supports ES256 (P-256) credentials only,
// which every platform authenticator in use today offers, and needs nothing
// beyond the standard library.
package webauthn

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
)

// Credential is a registered passkey public key.
type Credential struct {
	ID        string `json:"id"`
	X         []byte `json:"x"`
	Y         []byte `json:"y"`
	SignCount uint32 `json:"signCount"`
}

// RP identifies the relying party: the rpId (a host name) and the exact
// origin the browser reports in clientDataJSON.
type RP struct {
	ID     string
	Origin string
}

var b64 = base64.RawURLEncoding

// Decode parses an unpadded base64url field from the browser.
func Decode(s string) ([]byte, error) {
	if s == "" || len(s) > 8192 {
		return nil, errors.New("invalid base64url field")
	}
	return b64.DecodeString(s)
}

func (rp RP) checkClientData(raw []byte, typ, challenge string) error {
	var cd struct {
		Type      string `json:"type"`
		Challenge string `json:"challenge"`
		Origin    string `json:"origin"`
	}
	if err := json.Unmarshal(raw, &cd); err != nil {
		return errors.New("invalid clientDataJSON")
	}
	if cd.Type != typ {
		return errors.New("wrong ceremony type")
	}
	if subtle.ConstantTimeCompare([]byte(cd.Challenge), []byte(challenge)) != 1 {
		return errors.New("challenge mismatch")
	}
	if cd.Origin != rp.Origin {
		return fmt.Errorf("origin mismatch: got %q", cd.Origin)
	}
	return nil
}

func (rp RP) checkAuthData(authData []byte) (flags byte, signCount uint32, err error) {
	if len(authData) < 37 {
		return 0, 0, errors.New("authenticator data truncated")
	}
	want := sha256.Sum256([]byte(rp.ID))
	if subtle.ConstantTimeCompare(authData[:32], want[:]) != 1 {
		return 0, 0, errors.New("rpId mismatch")
	}
	flags = authData[32]
	if flags&0x01 == 0 {
		return 0, 0, errors.New("user not present")
	}
	if flags&0x04 == 0 {
		return 0, 0, errors.New("user not verified")
	}
	return flags, binary.BigEndian.Uint32(authData[33:37]), nil
}

// Register verifies a navigator.credentials.create() response and returns
// the new credential.
func (rp RP) Register(challenge, credentialID string, authData, clientData []byte) (*Credential, error) {
	if err := rp.checkClientData(clientData, "webauthn.create", challenge); err != nil {
		return nil, err
	}
	flags, count, err := rp.checkAuthData(authData)
	if err != nil {
		return nil, err
	}
	if flags&0x40 == 0 || len(authData) < 55 {
		return nil, errors.New("no attested credential data")
	}
	idLen := int(binary.BigEndian.Uint16(authData[53:55]))
	if len(authData) < 55+idLen {
		return nil, errors.New("credential id truncated")
	}
	credID := authData[55 : 55+idLen]
	if b64.EncodeToString(credID) != credentialID {
		return nil, errors.New("credential id mismatch")
	}
	key, _, err := decodeCBOR(authData, 55+idLen, 0)
	if err != nil {
		return nil, fmt.Errorf("public key: %w", err)
	}
	x, y, err := coseES256(key)
	if err != nil {
		return nil, err
	}
	return &Credential{ID: credentialID, X: x, Y: y, SignCount: count}, nil
}

// Assert verifies a navigator.credentials.get() response against cred and
// returns the new signature counter.
func (rp RP) Assert(cred Credential, challenge string, authData, clientData, sig []byte) (uint32, error) {
	if err := rp.checkClientData(clientData, "webauthn.get", challenge); err != nil {
		return 0, err
	}
	_, count, err := rp.checkAuthData(authData)
	if err != nil {
		return 0, err
	}
	pub, err := publicKey(cred.X, cred.Y)
	if err != nil {
		return 0, err
	}
	cdHash := sha256.Sum256(clientData)
	digest := sha256.Sum256(append(bytes.Clone(authData), cdHash[:]...))
	if !verifySig(pub, digest[:], sig) {
		return 0, errors.New("signature invalid")
	}
	// Authenticators that do not count always report 0; once a credential
	// has counted, the value must strictly increase.
	if cred.SignCount > 0 && count <= cred.SignCount {
		return 0, errors.New("signature counter did not increase (cloned authenticator?)")
	}
	return count, nil
}

// verifySig accepts the ASN.1 DER signature WebAuthn mandates and, for
// lenient clients, a raw 64-byte r||s.
func verifySig(pub *ecdsa.PublicKey, digest, sig []byte) bool {
	if ecdsa.VerifyASN1(pub, digest, sig) {
		return true
	}
	if len(sig) != 64 {
		return false
	}
	der, err := asn1.Marshal(struct{ R, S *big.Int }{new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])})
	return err == nil && ecdsa.VerifyASN1(pub, digest, der)
}

func publicKey(x, y []byte) (*ecdsa.PublicKey, error) {
	if len(x) != 32 || len(y) != 32 {
		return nil, errors.New("malformed EC public key")
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), append(append([]byte{4}, x...), y...))
	if err != nil {
		return nil, errors.New("public key is not on P-256")
	}
	return pub, nil
}

func coseES256(v any) (x, y []byte, err error) {
	m, ok := v.(map[any]any)
	if !ok {
		return nil, nil, errors.New("COSE key is not a map")
	}
	if m[int64(1)] != int64(2) || m[int64(3)] != int64(-7) || m[int64(-1)] != int64(1) {
		return nil, nil, errors.New("only ES256 (EC2 P-256) passkeys are supported")
	}
	x, _ = m[int64(-2)].([]byte)
	y, _ = m[int64(-3)].([]byte)
	if _, err := publicKey(x, y); err != nil {
		return nil, nil, err
	}
	return x, y, nil
}

// decodeCBOR decodes the subset of CBOR used by COSE keys: integers, byte
// and text strings, arrays, maps and simple values.
func decodeCBOR(b []byte, pos, depth int) (any, int, error) {
	if depth > 8 {
		return nil, 0, errors.New("cbor nesting too deep")
	}
	if pos >= len(b) {
		return nil, 0, errors.New("cbor truncated")
	}
	major, ai := b[pos]>>5, b[pos]&31
	pos++
	if major == 7 {
		switch ai {
		case 20:
			return false, pos, nil
		case 21:
			return true, pos, nil
		case 22, 23:
			return nil, pos, nil
		}
		return nil, 0, errors.New("unsupported cbor simple value")
	}
	var arg uint64
	switch {
	case ai < 24:
		arg = uint64(ai)
	case ai >= 24 && ai <= 27:
		n := 1 << (ai - 24)
		if pos+n > len(b) {
			return nil, 0, errors.New("cbor truncated")
		}
		for _, c := range b[pos : pos+n] {
			arg = arg<<8 | uint64(c)
		}
		pos += n
	default:
		return nil, 0, errors.New("indefinite cbor length not supported")
	}
	if arg > 1<<20 && major >= 2 {
		return nil, 0, errors.New("cbor item too large")
	}
	switch major {
	case 0:
		return int64(arg), pos, nil
	case 1:
		return -1 - int64(arg), pos, nil
	case 2, 3:
		end := pos + int(arg)
		if end > len(b) {
			return nil, 0, errors.New("cbor truncated")
		}
		if major == 3 {
			return string(b[pos:end]), end, nil
		}
		return bytes.Clone(b[pos:end]), end, nil
	case 4:
		arr := make([]any, 0, min(arg, 16))
		for range arg {
			v, next, err := decodeCBOR(b, pos, depth+1)
			if err != nil {
				return nil, 0, err
			}
			arr, pos = append(arr, v), next
		}
		return arr, pos, nil
	case 5:
		m := make(map[any]any, min(arg, 16))
		for range arg {
			k, next, err := decodeCBOR(b, pos, depth+1)
			if err != nil {
				return nil, 0, err
			}
			v, next2, err := decodeCBOR(b, next, depth+1)
			if err != nil {
				return nil, 0, err
			}
			switch k.(type) {
			case int64, string:
			default:
				return nil, 0, errors.New("unsupported cbor map key")
			}
			m[k], pos = v, next2
		}
		return m, pos, nil
	}
	return nil, 0, errors.New("unsupported cbor type")
}
