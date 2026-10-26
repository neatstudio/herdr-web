package sharedledger

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strconv"
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
	return i.SignMessage(attestationPayload(taskID, role, i.NodeID(), commit, digest))
}

// SignMessage signs an arbitrary domain-separated payload. Fleet hello and
// ledger operations use different payload shapes; they share only the key.
func (i Identity) SignMessage(payload []byte) string {
	if len(i.private) != ed25519.PrivateKeySize {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(i.private, payload))
}

func VerifyAttestation(taskID string, role Role, node, commit, digest, signature string) bool {
	return VerifyMessage(node, attestationPayload(taskID, role, node, commit, digest), signature)
}

func VerifyMessage(node string, payload []byte, signature string) bool {
	public, err := parseNodeID(node)
	if err != nil || signature == "" {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(raw) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(public, payload, raw)
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

// OperationPayload is the canonical bytes for a lease or lifecycle operation.
// Attestations have their own payload; keeping the domains separate prevents a
// signature from one operation being replayed as another.
func OperationPayload(op, taskID string, role Role, node string, version uint64, leaseSeconds int64, reason string) []byte {
	return []byte(strings.Join([]string{
		op, taskID, string(role), node,
		strconv.FormatUint(version, 10),
		strconv.FormatInt(leaseSeconds, 10),
		reason,
	}, "\x00"))
}

func (i Identity) SignOperation(op, taskID string, role Role, node string, version uint64, leaseSeconds int64, reason string) string {
	return i.SignMessage(OperationPayload(op, taskID, role, node, version, leaseSeconds, reason))
}

func VerifyOperation(op, taskID string, role Role, node string, version uint64, leaseSeconds int64, reason, signature string) bool {
	return VerifyMessage(node, OperationPayload(op, taskID, role, node, version, leaseSeconds, reason), signature)
}
