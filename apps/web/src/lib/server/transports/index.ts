/** The host's transport layer (docs/transports.md, "Host side"): providers per kind, the policy per plugin, the selector and broker connections. */
export { brokeredEndpoint, connectionFieldsFor, endpointKind, TransportProviderRegistry, transportProviders, type ConnectionTestResult, type ProviderHealth, type TransportConnectionConfig, type TransportProvider } from './provider';
export { DIRECT_PREFERENCE, grpcProvider, httpProvider } from './direct';
export { isDefaultPolicy, normalizePolicy, policyFromPreferred, transportPolicies, TransportPolicyStore, transportPolicySchema } from './policy-store';
export { isChoice, runModeOf, score, select, staticRank, type CallContext, type Candidate, type RunMode, type Selection, type SelectorInputs } from './selector';
export { configOf, envConnections, TransportConnections, transportConnections, TransportError, viewOf, type ConnectionChange, type ConnectionInput, type StoredConnection } from './connections';
export { BrokerConnectionManager, brokerConnections, DriverModules, driverModules, roundTrip, type BrokerConnectionManagerOptions, type BrokerDiscovery, type RoundTripResult } from './brokers';
export { BrokerPluginClient, capabilitiesOf, createBrokerProvider, fieldsOf, registerBrokerProviders, testConnection } from './broker-provider';
