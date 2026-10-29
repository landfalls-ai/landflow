package main

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
)

// iocType is what an indicator of compromise is. Hashes are one type: MD5, SHA-1 and SHA-256 look the same to every
// service here.
type iocType string

const (
	iocIP     iocType = "ip"
	iocDomain iocType = "domain"
	iocURL    iocType = "url"
	iocHash   iocType = "hash"
)

// ioc is a normalised indicator: a canonical IP, a lower-case domain or hash, a URL as given (refanged).
type ioc struct {
	Type  iocType `json:"type"`
	Value string  `json:"value"`
}

var (
	hashPattern   = regexp.MustCompile(`^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$`)
	domainPattern = regexp.MustCompile(`^(?i:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)$`)
	refangs       = strings.NewReplacer("[.]", ".", "(.)", ".", "{.}", ".", "[:]", ":", "[://]", "://", "[@]", "@", "[dot]", ".")
)

// refang undoes the defanging analysts use to share indicators safely: hxxp://example[.]com becomes http://example.com.
func refang(s string) string {
	s = refangs.Replace(strings.TrimSpace(s))
	if len(s) >= 4 && strings.EqualFold(s[:4], "hxxp") {
		s = "http" + s[4:]
	}
	return s
}

// parseIOC normalises typ and value. typ may be empty or "auto" to detect it; it also accepts the names other
// tools use (ipv4, ip-dst, hostname, sha256, md5, file…).
func parseIOC(typ, value string) (ioc, error) {
	value = refang(value)
	if value == "" {
		return ioc{}, errors.New("the indicator value is empty")
	}
	var t iocType
	switch strings.ToLower(strings.TrimSpace(typ)) {
	case "", "auto":
		t = detectType(value)
		if t == "" {
			return ioc{}, fmt.Errorf("cannot tell what %q is; set its type (ip, domain, url or hash)", value)
		}
	case "ip", "ipv4", "ipv6", "ip-src", "ip-dst", "ip_address", "ipaddress", "ip-address":
		t = iocIP
	case "domain", "hostname", "fqdn", "host":
		t = iocDomain
	case "url", "uri", "link":
		t = iocURL
	case "hash", "md5", "sha1", "sha-1", "sha256", "sha-256", "file", "filehash", "file_hash", "file-hash":
		t = iocHash
	default:
		return ioc{}, fmt.Errorf("unsupported indicator type %q (use ip, domain, url or hash)", typ)
	}
	switch t {
	case iocIP:
		addr, err := netip.ParseAddr(value)
		if err != nil {
			return ioc{}, fmt.Errorf("%q is not an IP address", value)
		}
		return ioc{iocIP, addr.WithZone("").Unmap().String()}, nil
	case iocHash:
		h := strings.ToLower(value)
		if !hashPattern.MatchString(h) {
			return ioc{}, fmt.Errorf("%q is not an MD5, SHA-1 or SHA-256 hash", value)
		}
		return ioc{iocHash, h}, nil
	case iocURL:
		u, err := url.Parse(value)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "ftp") {
			return ioc{}, fmt.Errorf("%q is not an http, https or ftp URL", value)
		}
		return ioc{iocURL, value}, nil
	default:
		d := strings.ToLower(strings.TrimSuffix(value, "."))
		if len(d) > 253 || !domainPattern.MatchString(d) {
			return ioc{}, fmt.Errorf("%q is not a domain name", value)
		}
		return ioc{iocDomain, d}, nil
	}
}

func detectType(value string) iocType {
	if _, err := netip.ParseAddr(value); err == nil {
		return iocIP
	}
	switch {
	case hashPattern.MatchString(strings.ToLower(value)):
		return iocHash
	case strings.Contains(value, "://"):
		return iocURL
	case strings.Contains(value, ".") && domainPattern.MatchString(strings.TrimSuffix(value, ".")):
		return iocDomain
	}
	return ""
}

// reservedPrefixes are the special-purpose ranges netip's Is* helpers do not cover (RFC 6890 and friends).
var reservedPrefixes = []struct {
	prefix netip.Prefix
	name   string
}{
	{netip.MustParsePrefix("0.0.0.0/8"), "\"this network\" (0.0.0.0/8)"},
	{netip.MustParsePrefix("100.64.0.0/10"), "carrier-grade NAT (100.64.0.0/10)"},
	{netip.MustParsePrefix("192.0.0.0/24"), "IETF protocol assignments (192.0.0.0/24)"},
	{netip.MustParsePrefix("192.0.2.0/24"), "documentation range (192.0.2.0/24)"},
	{netip.MustParsePrefix("198.18.0.0/15"), "benchmarking range (198.18.0.0/15)"},
	{netip.MustParsePrefix("198.51.100.0/24"), "documentation range (198.51.100.0/24)"},
	{netip.MustParsePrefix("203.0.113.0/24"), "documentation range (203.0.113.0/24)"},
	{netip.MustParsePrefix("240.0.0.0/4"), "reserved (240.0.0.0/4)"},
	{netip.MustParsePrefix("2001:db8::/32"), "documentation range (2001:db8::/32)"},
	{netip.MustParsePrefix("100::/64"), "discard-only range (100::/64)"},
}

// reservedReason says why addr is not worth asking threat-intel services about ("" for a routable public address).
func reservedReason(addr netip.Addr) string {
	addr = addr.WithZone("").Unmap()
	switch {
	case addr.IsLoopback():
		return "loopback address"
	case addr.IsPrivate():
		return "private address (RFC 1918 / ULA)"
	case addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast():
		return "link-local address"
	case addr.IsMulticast():
		return "multicast address"
	case addr.IsUnspecified():
		return "unspecified address"
	}
	for _, r := range reservedPrefixes {
		if r.prefix.Contains(addr) {
			return r.name
		}
	}
	return ""
}

// skipReason says why an IOC is not looked up ("" = look it up): a private, reserved or loopback IP, or a URL whose
// host is one.
func skipReason(o ioc) string {
	switch o.Type {
	case iocIP:
		if addr, err := netip.ParseAddr(o.Value); err == nil {
			return reservedReason(addr)
		}
	case iocURL:
		if u, err := url.Parse(o.Value); err == nil {
			if addr, err := netip.ParseAddr(u.Hostname()); err == nil {
				if why := reservedReason(addr); why != "" {
					return "URL host is a " + why
				}
			}
		}
	}
	return ""
}
