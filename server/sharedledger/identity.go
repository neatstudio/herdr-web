package sharedledger

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
)

// Identity is the node's signing key. The node id is the public key, so a peer
// can verify an attestation without a separate key registry.
type Identity struct {
	private ed25519.PrivateKey
	public  ed25519.PublicKey
}

func NewIdentity() (Identity, error) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, err
	}
	return Identity{private: private, public: public}, nil
}

func IdentityFromSeed(seed []byte) (Identity, error) {
	if len(seed) != ed25519.SeedSize {
		return Identity{}, errors.New("sharedledger: node seed must be 32 bytes")
	}
	private := ed25519.NewKeyFromSeed(seed)
	return Identity{private: private, public: private.Public().(ed25519.PublicKey)}, nil
}

func (i Identity) Seed() []byte {
	if len(i.private) != ed25519.PrivateKeySize {
		return nil
	}
	return append([]byte(nil), i.private.Seed()...)
}

func (i Identity) NodeID() string {
	if len(i.public) != ed25519.PublicKeySize {
		return ""
	}
	return "ed25519:" + base64.RawURLEncoding.EncodeToString(i.public)
}

func (i Identity) Sign(taskID string, role Role, commit, digest string) string {
	if len(i.private) != ed25519.PrivateKeySize {
		return ""
	}
	signature := ed25519.Sign(i.private, attestationPayload(taskID, role, i.NodeID(), commit, digest))
	return base64.RawURLEncoding.EncodeToString(signature)
}

func VerifyAttestation(taskID string, role Role, node, commit, digest, signature string) bool {
	public, err := parseNodeID(node)
	if err != nil || signature == "" {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(raw) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(public, attestationPayload(taskID, role, node, commit, digest), raw)
}

func parseNodeID(node string) (ed25519.PublicKey, error) {
	const prefix = "ed25519:"
	if !strings.HasPrefix(node, prefix) {
		return nil, errors.New("sharedledger: node id must be ed25519:<public key>")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(node, prefix))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("sharedledger: invalid node public key")
	}
	return ed25519.PublicKey(raw), nil
}

func attestationPayload(taskID string, role Role, node, commit, digest string) []byte {
	return []byte(strings.Join([]string{taskID, string(role), node, commit, digest}, "\x00"))
}
