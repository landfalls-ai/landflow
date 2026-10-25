package landflow

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
)

var (
	testSVG = []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#0d9488"/></svg>`)
	testPNG = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 8)...)
)

func dataURL(mime string, b []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(b)
}

func iconNode(name, icon string) badNode {
	return badNode{NodeDescriptor{Name: name, DisplayName: name, Icon: icon}}
}

func TestFileIcons(t *testing.T) {
	icons := fstest.MapFS{
		"icons/plugin.svg": {Data: testSVG},
		"icons/node.png":   {Data: testPNG},
	}
	p, err := BuildPlugin(PluginInfo{ID: "x", Name: "X", Version: "1", Icon: "file:icons/plugin.svg", Color: "#0d9488", IconFS: icons},
		iconNode("png", "file:./icons/node.png"), iconNode("lucide", "lucide:hash"), iconNode("embedded", SVGIcon(testSVG)))
	if err != nil {
		t.Fatal(err)
	}
	m := p.Manifest()
	if m.Plugin.Icon != dataURL("image/svg+xml", testSVG) || m.Plugin.Color != "#0d9488" || m.Plugin.IconFS != nil {
		t.Errorf("plugin info = %+v", m.Plugin)
	}
	want := []string{dataURL("image/png", testPNG), "lucide:hash", dataURL("image/svg+xml", testSVG)}
	for i, d := range m.Nodes {
		if d.Icon != want[i] {
			t.Errorf("node %s icon = %.60q, want %.60q", d.Name, d.Icon, want[i])
		}
	}
	raw, _ := json.Marshal(m)
	if strings.Contains(string(raw), "file:") || !strings.Contains(string(raw), `"color":"#0d9488"`) {
		t.Errorf("manifest JSON = %.300s", raw)
	}
	// gRPC carries the colour in PluginInfo field 11.
	if back := PluginInfoFromProto(pluginInfoToProto(m.Plugin)); back.Color != "#0d9488" || back.Icon != m.Plugin.Icon {
		t.Errorf("proto round trip lost icon/color: %+v", back)
	}
}

func TestFileIconErrors(t *testing.T) {
	icons := fstest.MapFS{
		"big.svg":  {Data: append([]byte("<svg>"), make([]byte, MaxIconBytes)...)},
		"fake.svg": {Data: []byte("not an svg")},
		"fake.png": {Data: []byte("not a png")},
		"icon.gif": {Data: []byte("GIF89a")},
	}
	_, err := BuildPlugin(PluginInfo{ID: "x", Name: "X", Version: "1", Icon: "file:missing.svg", Color: "teal", IconFS: icons},
		iconNode("big", "file:big.svg"), iconNode("fakesvg", "file:fake.svg"), iconNode("fakepng", "file:fake.png"), iconNode("gif", "file:icon.gif"))
	if err == nil {
		t.Fatal("expected icon errors")
	}
	for _, want := range []string{
		`plugin icon "file:missing.svg": missing.svg not found in IconFS`, `plugin color "teal" must be a hex colour`,
		"big: icon \"file:big.svg\": 65541 bytes exceeds the 64 KB limit", "fakesvg: icon \"file:fake.svg\": content is not a valid SVG",
		"fakepng: icon \"file:fake.png\": content is not a valid PNG", "gif: icon \"file:icon.gif\": only .svg and .png",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error missing %q:\n%s", want, err)
		}
	}

	_, err = BuildPlugin(PluginInfo{ID: "x", Name: "X", Version: "1"}, iconNode("n", "file:n.svg"))
	if err == nil || !strings.Contains(err.Error(), "set PluginInfo.IconFS") {
		t.Errorf("file: icon without IconFS: %v", err)
	}

	defer func() {
		if recover() == nil {
			t.Error("SVGIcon must panic on non-SVG input")
		}
	}()
	SVGIcon([]byte("<html></html>"))
}
