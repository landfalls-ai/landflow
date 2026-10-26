package kit

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// PythonInterpreter is the Python used to run sdks/python/tests/conformance_plugin.py: LANDFLOW_TEST_PYTHON, else the
// py-insights venv (grpcio installed), else "" (the Python runs are skipped).
func PythonInterpreter() string {
	if p := os.Getenv("LANDFLOW_TEST_PYTHON"); p != "" {
		return p
	}
	root, err := RepoRoot()
	if err != nil {
		return ""
	}
	candidate := filepath.Join(root, "plugins", "py-insights", ".venv", "bin", "python")
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return ""
}

// PythonPlugin is the conformance plugin run with the Python SDK as a child process.
type PythonPlugin struct {
	cmd    *exec.Cmd
	Hooks  *HTTPHooks
	Output *bytes.Buffer
	mu     sync.Mutex
}

// StartPythonPlugin runs the Python conformance plugin on httpPort/grpcPort with its hooks endpoint on hooksPort,
// announce and the bridge launcher off, LANDFLOW_TRANSPORTS unset (extra is appended to the environment).
func StartPythonPlugin(ctx context.Context, python string, httpPort, grpcPort, hooksPort int, extra ...string) (*PythonPlugin, error) {
	root, err := RepoRoot()
	if err != nil {
		return nil, err
	}
	script := filepath.Join(root, "sdks", "python", "tests", "conformance_plugin.py")
	cmd := exec.Command(python, "-I", script, "--http", strconv.Itoa(httpPort), "--grpc", strconv.Itoa(grpcPort), "--hooks", strconv.Itoa(hooksPort))
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	env := []string{"LANDFLOW_REGISTRY_URL=off", "LANDFLOW_BRIDGE=off", "LANDFLOW_LOG_LEVEL=warn", "OTEL_SDK_DISABLED=true", "PYTHONUNBUFFERED=1"}
	for _, kv := range os.Environ() {
		switch {
		case bytes.HasPrefix([]byte(kv), []byte("LANDFLOW_TRANSPORTS=")), bytes.HasPrefix([]byte(kv), []byte("LANDFLOW_HTTP_PORT=")), bytes.HasPrefix([]byte(kv), []byte("LANDFLOW_GRPC_PORT=")):
			continue
		}
		env = append(env, kv)
	}
	cmd.Env = append(env, extra...)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &PythonPlugin{cmd: cmd, Hooks: &HTTPHooks{Base: fmt.Sprintf("http://127.0.0.1:%d", hooksPort)}, Output: &out}
	if err := WaitHealthy(ctx, fmt.Sprintf("http://127.0.0.1:%d", httpPort), 20*time.Second); err != nil {
		p.Stop()
		return nil, fmt.Errorf("%w\n%s", err, out.String())
	}
	return p, nil
}

// Stop terminates the child.
func (p *PythonPlugin) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd.Process == nil {
		return
	}
	_ = p.cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _, _ = p.cmd.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = p.cmd.Process.Kill()
		<-done
	}
}

// HTTPHooks reads the Python plugin's hooks over its side endpoint (GET /hooks, POST /hooks/reset).
type HTTPHooks struct {
	Base string
}

type hooksDoc struct {
	Executions int            `json:"executions"`
	ByNode     map[string]int `json:"byNode"`
	Sleeps     []struct {
		Aborted bool `json:"aborted"`
	} `json:"sleeps"`
}

func (h *HTTPHooks) read() hooksDoc {
	var doc hooksDoc
	resp, err := http.Get(h.Base + "/hooks")
	if err != nil {
		return doc
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(data, &doc)
	return doc
}

// Reset clears the counts.
func (h *HTTPHooks) Reset() {
	resp, err := http.Post(h.Base+"/hooks/reset", "application/json", nil)
	if err == nil {
		resp.Body.Close()
	}
}

// Executions is the number of node runs since Reset.
func (h *HTTPHooks) Executions() int { return h.read().Executions }

// ByNode is the number of runs of one node since Reset.
func (h *HTTPHooks) ByNode(name string) int { return h.read().ByNode[name] }

// LastSleepAborted reports the last sleep's abort flag.
func (h *HTTPHooks) LastSleepAborted() (bool, bool) {
	doc := h.read()
	if len(doc.Sleeps) == 0 {
		return false, false
	}
	return doc.Sleeps[len(doc.Sleeps)-1].Aborted, true
}
