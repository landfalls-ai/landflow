package transport

// Channel names (docs/transports.md "One core, small drivers", docs/protocol.md
// §14.2): <prefix>.v1.<role>…. The prefix (default "landflow") lets two Landflow
// instances share a broker; the protocol version keeps a future v2 apart.
//
//	request   landflow.v1.plugin.<pluginId>              shared     every replica of the plugin, work-shared
//	instance  landflow.v1.instance.<pluginId>.<instance> shared     one plugin process (calls that must reach it)
//	reply     landflow.v1.reply.<hostInstanceId>         broadcast  one host process
//	registry  landflow.v1.registry                       broadcast  every host (announce, withdraw)
//	control   landflow.v1.control.<pluginId>             broadcast  every replica of the plugin (cancel)

import (
	"fmt"
	"regexp"
	"time"
)

const (
	DefaultPrefix  = "landflow"
	ChannelVersion = "v1"
)

var (
	channelNameRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	endpointRE    = regexp.MustCompile(`^([a-z][a-z0-9]*)://([A-Za-z0-9._-]{1,64})/([A-Za-z0-9._-]{1,128})$`)
)

// Names builds the channel names for one prefix.
type Names struct {
	base string
}

// CheckName validates a channel-name segment (prefix, plugin id, instance id).
func CheckName(what, value string) error {
	if !channelNameRE.MatchString(value) {
		return fmt.Errorf("transport: %s %q must be 1-128 characters of letters, digits, \".\", \"_\" or \"-\"", what, value)
	}
	return nil
}

// NewNames returns the names for prefix ("" = DefaultPrefix); it panics on a malformed prefix.
func NewNames(prefix string) Names {
	if prefix == "" {
		prefix = DefaultPrefix
	}
	if err := CheckName("channel prefix", prefix); err != nil {
		panic(err)
	}
	return Names{base: prefix + "." + ChannelVersion}
}

func mustName(what, value string) string {
	if err := CheckName(what, value); err != nil {
		panic(err)
	}
	return value
}

// Request is the plugin's shared request channel.
func (n Names) Request(pluginID string) string {
	return n.base + ".plugin." + mustName("plugin id", pluginID)
}

// Instance is one plugin process's channel.
func (n Names) Instance(pluginID, instanceID string) string {
	return n.base + ".instance." + mustName("plugin id", pluginID) + "." + mustName("instance id", instanceID)
}

// Reply is one host process's reply channel.
func (n Names) Reply(hostInstanceID string) string {
	return n.base + ".reply." + mustName("host instance id", hostInstanceID)
}

// Registry is the registry channel (announce, withdraw).
func (n Names) Registry() string { return n.base + ".registry" }

// Control is the plugin's control channel (cancel).
func (n Names) Control(pluginID string) string {
	return n.base + ".control." + mustName("plugin id", pluginID)
}

// RequestSpec is the ChannelSpec of a request channel (durable, shared; ttl 0 = none).
func RequestSpec(name string, ttl time.Duration) ChannelSpec {
	return ChannelSpec{Name: name, Role: RoleRequest, Delivery: DeliveryShared, Durable: true, TTL: ttl}
}

// InstanceSpec is the ChannelSpec of an instance channel.
func InstanceSpec(name string) ChannelSpec {
	return ChannelSpec{Name: name, Role: RoleInstance, Delivery: DeliveryShared, Durable: false}
}

// ReplySpec is the ChannelSpec of a reply channel (5 min TTL).
func ReplySpec(name string) ChannelSpec {
	return ChannelSpec{Name: name, Role: RoleReply, Delivery: DeliveryBroadcast, Durable: false, TTL: 5 * time.Minute}
}

// RegistrySpec is the ChannelSpec of the registry channel (60 s TTL).
func RegistrySpec(name string) ChannelSpec {
	return ChannelSpec{Name: name, Role: RoleRegistry, Delivery: DeliveryBroadcast, Durable: false, TTL: time.Minute}
}

// ControlSpec is the ChannelSpec of a control channel (60 s TTL).
func ControlSpec(name string) ChannelSpec {
	return ChannelSpec{Name: name, Role: RoleControl, Delivery: DeliveryBroadcast, Durable: false, TTL: time.Minute}
}

// BrokerEndpoint is a brokered endpoint, <kind>://<connectionId>/<pluginId>, never with hosts or passwords.
func BrokerEndpoint(kind, connectionID, pluginID string) string {
	return kind + "://" + connectionID + "/" + pluginID
}

// ParseBrokerEndpoint reads a brokered endpoint; ok is false for direct (http, grpc) or malformed ones.
func ParseBrokerEndpoint(endpoint string) (kind, connectionID, pluginID string, ok bool) {
	m := endpointRE.FindStringSubmatch(endpoint)
	if m == nil {
		return "", "", "", false
	}
	switch m[1] {
	case "http", "https", "grpc", "grpcs":
		return "", "", "", false
	}
	return m[1], m[2], m[3], true
}
