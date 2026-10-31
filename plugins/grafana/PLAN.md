# Grafana Plugin Plan

## Plugin Information
- **Package name**: `@landflow/plugin-grafana`
- **Plugin ID**: `grafana`
- **HTTP port**: 7120 (not used by any other plugin)
- **gRPC port**: 7220 (not used by any other plugin)
- **Credential type**: `grafana_alertmanager_api_token`
- **Credential fields**:
  - `alertmanagerUrl` (string): The base URL of the Grafana Alertmanager API
  - `apiToken` (string): Authentication token for the Alertmanager API

## Nodes and Operations

### 1. Get Alerts (`getAlerts`)
- **Operation**: Fetches active firing alerts from Grafana Alertmanager API
- **HTTP Method**: GET
- **Path**: `/api/v2/alerts?filter=active`
- **Authentication**: Bearer token in Authorization header

### 2. Get Alert Details (`getAlertDetails`)
- **Operation**: Retrieves detailed information for a specific alert by its ID
- **HTTP Method**: GET
- **Path**: `/api/v2/alerts/{alertId}`
- **Authentication**: Bearer token in Authorization header

### 3. Acknowledge Alert (`acknowledgeAlert`)
- **Operation**: Acknowledges or silences a specific alert in Grafana Alertmanager
- **HTTP Method**: POST (for silencing) or GET (for acknowledging)
- **Path**: `/api/v2/silences` (when silencing) or `/api/v2/alerts/{alertId}` (when acknowledging)
- **Authentication**: Bearer token in Authorization header

## Files to Write
1. `package.json` - Plugin metadata and dependencies
2. `src/main.ts` - Plugin entry point with HTTP/gRPC server setup
3. `src/nodes/get-alerts.ts` - Node for fetching alerts
4. `src/nodes/get-alert-details.ts` - Node for getting alert details
5. `src/nodes/acknowledge-alert.ts` - Node for acknowledging/silencing alerts
6. `test/` directory with test files

## Test Plan
Each node will have a test that:
1. Sets up a mock HTTP server
2. Runs the node against the fake server
3. Verifies the HTTP method used
4. Verifies the path used
5. Verifies the authentication header
6. Checks that the parsed output is correct

The tests will use `fetch` to simulate HTTP requests and verify the behavior matches the expected API calls.