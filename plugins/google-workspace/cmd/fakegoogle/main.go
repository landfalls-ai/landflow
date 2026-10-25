// Command fakegoogle serves the in-memory Google double (internal/fakegoogle)
// for trying the plugin without a Google account. It generates a throwaway
// RSA key for the service account, writes the private half to -key-out and
// seeds a spreadsheet and a couple of emails.
//
//	go run ./cmd/fakegoogle -addr 127.0.0.1:7999 -key-out /tmp/fake-sa.pem
//
// Point a credential's Token URL at http://ADDR/token and its API Base URL at
// http://ADDR. Add data while it runs:
//
//	curl -X POST http://ADDR/_fake/gmail/messages -d '{"from":"a@example.com","to":"me@example.com","subject":"Hi","text":"…"}'
//	curl -X POST http://ADDR/_fake/sheets/sheet-demo/rows -d '{"sheet":"Leads","rows":[["Dee","dee@example.com",70]]}'
//	curl http://ADDR/_fake/state
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/landflow/landflow/plugins/google-workspace/internal/fakegoogle"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	keyOut := flag.String("key-out", "", "write the service account's throwaway private key (PEM) to this file")
	email := flag.String("email", "robot@fake-project.iam.gserviceaccount.com", "service account email (JWT iss)")
	clientID := flag.String("client-id", "fake-client.apps.googleusercontent.com", "OAuth2 client ID accepted by the refresh grant")
	clientSecret := flag.String("client-secret", "fake-client-secret", "OAuth2 client secret accepted by the refresh grant")
	refreshToken := flag.String("refresh-token", "fake-refresh-token", "refresh token accepted by the refresh grant")
	flag.Parse()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatal(err)
	}
	if *keyOut != "" {
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(*keyOut, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
			log.Fatal(err)
		}
	}

	fake := fakegoogle.New()
	fake.PublicKey = &key.PublicKey
	fake.ServiceAccountEmail = *email
	fake.ClientID, fake.ClientSecret, fake.RefreshToken = *clientID, *clientSecret, *refreshToken
	fake.Log = log.Printf // method and path only
	seed(fake)

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("fakegoogle listening on http://%s (service account %s)\n", ln.Addr(), *email)
	srv := &http.Server{Handler: fake, ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.Serve(ln))
}

// seed adds a demo spreadsheet and two received emails.
func seed(fake *fakegoogle.Server) {
	fake.AddSpreadsheet("sheet-demo", "Landflow Demo", &fakegoogle.Sheet{ID: 0, Title: "Leads", Rows: [][]any{
		{"Name", "Email", "Score"},
		{"Ada", "ada@example.com", 90.0},
		{"Bob", "bob@example.com", 50.0},
	}})
	start := time.Now().Add(-time.Hour)
	fake.AddMessage(fakegoogle.SimpleMessage{From: "Ada <ada@example.com>", To: "me@example.com", Subject: "Welcome",
		Text: "Hello from the fake mailbox.", Time: start})
	fake.AddMessage(fakegoogle.SimpleMessage{From: "billing@example.com", To: "me@example.com", Subject: "Invoice 1001",
		Text: "Your invoice is attached.", Labels: []string{"INBOX", "UNREAD", "Label_1"}, Time: start.Add(10 * time.Minute)})
}
