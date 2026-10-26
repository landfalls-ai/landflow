/** The host's transport layer (docs/transports.md, "Host side"): providers per kind, the policy per plugin, the selector and broker connections. */
export { brokeredEndpoint, connectionFieldsFor, endpointKind, TransportProviderRegistry, transportProviders, type ConnectionTestResult, type ProviderHealth, type TransportConnectionConfig, type TransportProvider } from './provider';
export { DIRECT_PREFERENCE, grpcProvider, httpProvider } from './direct';
export { isDefaultPolicy, normalizePolicy, policyFromPreferred, transportPolicies, TransportPolicyStore, transportPolicySchema } from './policy-store';
export { DEFAULT_MAX_CONCURRENCY, isChoice, isDirect, isInteractive, PRIOR_MS, rank, runModeOf, score, scoreParts, select, SPILL_SHARE, spillThreshold, staticRank, type CallContext, type Candidate, type RunMode, type ScoreParts, type Selection, type SelectorInputs } from './selector';
export { sizeBucket, TransportStats, WINDOW_MS, type CallOutcome, type FailureCounts, type SizeBucket } from './stats';
export { BREAKER_DEFAULTS, CircuitBreaker, type BreakerOptions } from './breaker';
export { AUTO, classifyError, parseRetryAfter, TransportAuto, transportAuto, type AutoCall, type AutoEndpoint, type AutoSource, type TransportAutoOptions, type Verdict, type VerdictKind } from './auto';
export { configOf, envConnections, TransportConnections, transportConnections, TransportError, viewOf, type ConnectionChange, type ConnectionInput, type StoredConnection } from './connections';
export { BrokerConnectionManager, brokerConnections, DriverModules, driverModules, roundTrip, type BrokerConnectionManagerOptions, type BrokerDiscovery, type RoundTripResult } from './brokers';
export { BrokerPluginClient, capabilitiesOf, createBrokerProvider, fieldsOf, registerBrokerProviders, testConnection } from './broker-provider';
