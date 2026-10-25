package landflow

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// Registry proofs (docs/protocol.md §13). A host that finds plugins itself (Kubernetes discovery) gets no announce on
// which to check LANDFLOW_REGISTRY_SECRET, so it sends a random challenge with GetManifest (HTTP header or gRPC
// metadata x-landflow-registry-challenge) and the plugin answers with x-landflow-registry-proof: an HMAC of the
// challenge and its plugin id, keyed with the secret. The secret itself never travels. Both servers answer
// automatically when LANDFLOW_REGISTRY_SECRET is set.
const (
	RegistryChallengeHeader = "X-Landflow-Registry-Challenge"
	RegistryProofHeader     = "X-Landflow-Registry-Proof"
	// MaxRegistryChallengeLength: longer challenges are ignored (hosts send 43 characters).
	MaxRegistryChallengeLength = 256
)

// RegistryProof is the hex HMAC-SHA256 of "landflow-registry-proof/v1\n<pluginID>\n<challenge>", keyed with secret.
func RegistryProof(secret, pluginID, challenge string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("landflow-registry-proof/v1\n" + pluginID + "\n" + challenge))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyRegistryProof reports whether proof answers challenge for pluginID under secret (constant-time).
func VerifyRegistryProof(secret, pluginID, challenge, proof string) bool {
	return hmac.Equal([]byte(RegistryProof(secret, pluginID, challenge)), []byte(proof))
}

// answerRegistryChallenge is the proof for challenge when LANDFLOW_REGISTRY_SECRET is set, else "".
func (p *Plugin) answerRegistryChallenge(challenge string) string {
	secret := os.Getenv("LANDFLOW_REGISTRY_SECRET")
	if secret == "" || challenge == "" || len(challenge) > MaxRegistryChallengeLength {
		return ""
	}
	return RegistryProof(secret, p.info.ID, challenge)
}

// sendRegistryProof answers a GetManifest challenge in the gRPC response header.
func (p *Plugin) sendRegistryProof(ctx context.Context) {
	md, _ := metadata.FromIncomingContext(ctx)
	values := md.Get(RegistryChallengeHeader)
	if len(values) == 0 {
		return
	}
	if proof := p.answerRegistryChallenge(values[0]); proof != "" {
		_ = grpc.SetHeader(ctx, metadata.Pairs(RegistryProofHeader, proof))
	}
}
