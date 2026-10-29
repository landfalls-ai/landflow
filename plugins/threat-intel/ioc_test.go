package main

import (
	"net/netip"
	"strings"
	"testing"
)

func TestParseIOC(t *testing.T) {
	sha1 := strings.Repeat("1f", 20)
	cases := []struct {
		typ, value string
		want       ioc
		wantErr    string
	}{
		{"", "8.8.8.8", ioc{iocIP, "8.8.8.8"}, ""},
		{"ipv4", " 8.8.8.8 ", ioc{iocIP, "8.8.8.8"}, ""},
		{"IP", "2001:DB8::1", ioc{iocIP, "2001:db8::1"}, ""},
		{"ip", "::ffff:1.2.3.4", ioc{iocIP, "1.2.3.4"}, ""},
		{"ip", "1[.]2[.]3[.]4", ioc{iocIP, "1.2.3.4"}, ""},
		{"auto", "Example.COM.", ioc{iocDomain, "example.com"}, ""},
		{"hostname", "mail.Example.com", ioc{iocDomain, "mail.example.com"}, ""},
		{"", "evil[.]example", ioc{iocDomain, "evil.example"}, ""},
		{"", "hxxps://evil[.]example/a?b=1", ioc{iocURL, "https://evil.example/a?b=1"}, ""},
		{"url", "http://x.test/Path", ioc{iocURL, "http://x.test/Path"}, ""},
		{"", strings.ToUpper(sha1), ioc{iocHash, sha1}, ""},
		{"md5", strings.Repeat("A", 32), ioc{iocHash, strings.Repeat("a", 32)}, ""},
		{"file", strings.Repeat("0", 64), ioc{iocHash, strings.Repeat("0", 64)}, ""},
		{"ip", "banana", ioc{}, "not an IP"},
		{"hash", "abc", ioc{}, "not an MD5"},
		{"url", "not a url", ioc{}, "not an http"},
		{"url", "javascript://x", ioc{}, "not an http"},
		{"domain", "bad domain!", ioc{}, "not a domain"},
		{"", "???", ioc{}, "cannot tell"},
		{"", "", ioc{}, "empty"},
		{"mac", "aa:bb", ioc{}, "unsupported indicator type"},
	}
	for _, tc := range cases {
		got, err := parseIOC(tc.typ, tc.value)
		if tc.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("parseIOC(%q, %q) error = %v, want %q", tc.typ, tc.value, err, tc.wantErr)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("parseIOC(%q, %q) = %+v, %v; want %+v", tc.typ, tc.value, got, err, tc.want)
		}
	}
}

func TestReservedReason(t *testing.T) {
	reserved := []string{
		"10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "127.8.8.8", "::1", "fc00::1", "fd00::1",
		"169.254.169.254", "fe80::1", "0.0.0.0", "::", "224.0.0.251", "ff02::1", "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.1",
		"198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "240.0.0.1", "255.255.255.255", "2001:db8::1", "::ffff:10.0.0.1",
	}
	for _, v := range reserved {
		if reservedReason(netip.MustParseAddr(v)) == "" {
			t.Errorf("%s is not reported as reserved", v)
		}
	}
	public := []string{"1.1.1.1", "8.8.8.8", "9.9.9.9", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "198.17.0.1", "198.20.0.1", "192.0.1.1", "2606:4700:4700::1111", "2a00:1450:4001::1"}
	for _, v := range public {
		if why := reservedReason(netip.MustParseAddr(v)); why != "" {
			t.Errorf("%s reported as %s", v, why)
		}
	}
}

func TestSkipReasonForURLs(t *testing.T) {
	o, _ := parseIOC("url", "http://192.168.1.5:8080/x")
	contains(t, skipReason(o), "URL host")
	o, _ = parseIOC("url", "http://example.com/x")
	eq(t, "public url", skipReason(o), "")
	o, _ = parseIOC("domain", "localhost")
	eq(t, "domain", skipReason(o), "")
}
