package app

import "testing"

func TestProtectedProxyRouteRequiresTheCurrentLocalRelay(t *testing.T) {
	const relay = "127.0.0.1:55367"
	cases := []struct {
		name  string
		route string
		want  bool
	}{
		{name: "current relay", route: "SOCKS5 127.0.0.1:55367", want: true},
		{name: "direct", route: "DIRECT", want: false},
		{name: "different relay", route: "SOCKS5 127.0.0.1:55368", want: false},
		{name: "fallback after protected proxy", route: "SOCKS5 127.0.0.1:55367; DIRECT", want: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := protectedProxyRoute(test.route, relay); got != test.want {
				t.Fatalf("protectedProxyRoute(%q, %q) = %t, want %t", test.route, relay, got, test.want)
			}
		})
	}
}
