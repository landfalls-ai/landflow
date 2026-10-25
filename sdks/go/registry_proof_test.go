package landflow

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

// The same vector is checked by the TypeScript and Python SDKs and the host.
const proofVector = "d6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e"

func TestRegistryProofVector(t *testing.T) {
	if got := RegistryProof("registry-s3cret", "test-plugin", "challenge-123"); got != proofVector {
		t.Fatalf("RegistryProof = %s", got)
	}
	if !VerifyRegistryProof("registry-s3cret", "test-plugin", "challenge-123", proofVector) || VerifyRegistryProof("other", "test-plugin", "challenge-123", proofVector) {
		t.Fatal("VerifyRegistryProof")
	}
}

func TestRegistryProofHTTP(t *testing.T) {
	srv := httptest.NewServer(testPlugin().Handler())
	defer srv.Close()
	manifest := func(challenge string) string {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+PathManifest, nil)
		if challenge != "" {
			req.Header.Set(RegistryChallengeHeader, challenge)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.Header.Get(RegistryProofHeader)
	}
	t.Setenv("LANDFLOW_REGISTRY_SECRET", "")
	if got := manifest("challenge-123"); got != "" {
		t.Errorf("no secret: proof %q", got)
	}
	t.Setenv("LANDFLOW_REGISTRY_SECRET", "registry-s3cret")
	if got := manifest("challenge-123"); got != proofVector {
		t.Errorf("proof = %q", got)
	}
	if got := manifest(""); got != "" {
		t.Errorf("no challenge: proof %q", got)
	}
	if got := manifest(strings.Repeat("a", MaxRegistryChallengeLength+1)); got != "" {
		t.Errorf("long challenge: proof %q", got)
	}
}

func TestRegistryProofGRPC(t *testing.T) {
	t.Setenv("LANDFLOW_REGISTRY_SECRET", "registry-s3cret")
	client := bufconnClient(t, testPlugin())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var header metadata.MD
	ctx = metadata.AppendToOutgoingContext(ctx, "x-landflow-registry-challenge", "challenge-123")
	if _, err := client.GetManifest(ctx, &pb.GetManifestRequest{}, grpc.Header(&header)); err != nil {
		t.Fatal(err)
	}
	if got := header.Get(RegistryProofHeader); len(got) != 1 || got[0] != proofVector {
		t.Errorf("proof metadata = %v", got)
	}
	header = nil
	if _, err := client.GetManifest(context.Background(), &pb.GetManifestRequest{}, grpc.Header(&header)); err != nil {
		t.Fatal(err)
	}
	if got := header.Get(RegistryProofHeader); len(got) != 0 {
		t.Errorf("unchallenged proof metadata = %v", got)
	}
}
