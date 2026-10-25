package landflow

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"
)

// Icons. PluginInfo.Icon and NodeDescriptor.Icon may be written n8n-style as
// "file:icons/hash.svg"; NewPlugin reads the file from PluginInfo.IconFS
// (typically an embed.FS) and inlines it as a data: URL, so the icon travels
// the same way over HTTP and gRPC and the host never sees a path:
//
//	//go:embed icons
//	var icons embed.FS
//
//	landflow.NewPlugin(landflow.PluginInfo{ID: "go-crypto", Icon: "file:icons/crypto.svg", IconFS: icons}, ...)
//
// For a single embedded file, SVGIcon does the same without an fs.FS.

// MaxIconBytes bounds an icon file: icons are inlined into every manifest.
const MaxIconBytes = 64 * 1024

var (
	pngSignature = []byte("\x89PNG\r\n\x1a\n")
	svgTag       = regexp.MustCompile(`<svg[\s>]`)
)

// SVGIcon returns an embedded SVG as a data: URL for PluginInfo.Icon or
// NodeDescriptor.Icon. It is meant for //go:embed'ed constants and panics if
// svg is not an SVG document or exceeds MaxIconBytes.
//
//	//go:embed icons/hash.svg
//	var hashSVG []byte
//	... Icon: landflow.SVGIcon(hashSVG),
func SVGIcon(svg []byte) string {
	url, err := iconDataURL("icon.svg", svg)
	if err != nil {
		panic("landflow: SVGIcon: " + err.Error())
	}
	return url
}

// iconDataURL validates an SVG/PNG by name and content and base64-encodes it.
func iconDataURL(name string, data []byte) (string, error) {
	var mime string
	switch strings.ToLower(path.Ext(name)) {
	case ".svg":
		mime = "image/svg+xml"
		if !svgTag.Match(data) {
			return "", errors.New("content is not a valid SVG file")
		}
	case ".png":
		mime = "image/png"
		if !bytes.HasPrefix(data, pngSignature) {
			return "", errors.New("content is not a valid PNG file")
		}
	default:
		return "", errors.New("only .svg and .png files are supported")
	}
	if len(data) > MaxIconBytes {
		return "", fmt.Errorf("%d bytes exceeds the %d KB limit (icons are inlined into the manifest)", len(data), MaxIconBytes/1024)
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// resolveIcon turns "file:<path>" into a data: URL read from fsys; any other
// icon (lucide:, emoji:, https:, data:) is returned unchanged.
func resolveIcon(icon string, fsys fs.FS) (string, error) {
	name, ok := strings.CutPrefix(icon, "file:")
	if !ok {
		return icon, nil
	}
	if fsys == nil {
		return "", fmt.Errorf("icon %q: set PluginInfo.IconFS (e.g. an embed.FS) to resolve file: icons", icon)
	}
	name = path.Clean(name)
	data, err := fs.ReadFile(fsys, name)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("icon %q: %s not found in IconFS", icon, name)
	}
	if err != nil {
		return "", fmt.Errorf("icon %q: %w", icon, err)
	}
	url, err := iconDataURL(name, data)
	if err != nil {
		return "", fmt.Errorf("icon %q: %w", icon, err)
	}
	return url, nil
}
