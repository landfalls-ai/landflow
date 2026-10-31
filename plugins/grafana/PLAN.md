# Grafana Plugin Plan

## Package Information
- **Package Name**: `@landflow/plugin-grafana`
- **Plugin ID**: `grafana`
- **HTTP Port**: 7105 (next available)
- **gRPC Port**: 7205 (next available)

## Credential Type
The plugin requires a credential of type `grafana_alertmanager_api_token` with the following fields:
- `baseUrl` (string, required): The base URL of the Grafana Alertmanager API endpoint (e.g., `http://localhost:9093`)
- `token` (string, required): The API token for authenticating with the Alertmanager API

## Nodes and Operations

### 1. Get Alerts
- **Node Name**: `getAlerts`
- **Description**: Fetches active firing alerts from Grafana Alertmanager API
- **HTTP Method**: GET
- **Path**: `/api/v1/alerts?filter=active`
- **Credential Required**: Yes (grafana_alertmanager_api_token)

### 2. Get Alert Details
- **Node Name**: `getAlertDetails`
- **Description**: Retrieves detailed information for a specific alert by ID
- **HTTP Method**: GET
- **Path**: `/api/v1/alerts/{alertId}`
- **Credential Required**: Yes (grafana_alertmanager_api_token)
- **Input Parameter**: `alertId` (string, required)

### 3. Acknowledge Alert
- **Node Name**: `acknowledgeAlert`
- **Description**: Acknowledges or silences a specific alert
- **HTTP Method**: POST
- **Path**: `/api/v1/silences`
- **Credential Required**: Yes (grafana_alertmanager_api_token)
- **Input Parameters**:
  - `alertId` (string, required): The ID of the alert to acknowledge
  - `duration` (number, optional): Duration in seconds for which to silence the alert

## Files to Create

1. `plugins/grafana/package.json` - Plugin package configuration
2. `plugins/grafana/src/main.ts` - Plugin entry point with node definitions
3. `plugins/grafana/src/nodes/get-alerts.ts` - Get alerts node implementation
4. `plugins/grafana/src/nodes/get-alert-details.ts` - Get alert details node implementation
5. `plugins/grafana/src/nodes/acknowledge-alert.ts` - Acknowledge alert node implementation
6. `plugins/grafana/src/credentials.ts` - Credential type definition
7. `plugins/grafana/test/` - Test files for all nodes

## Test Plan

Create a fake HTTP server under `plugins/grafana/test/` to mock the Grafana Alertmanager API endpoints:
- `/api/v1/alerts?filter=active` - Returns active alerts list
- `/api/v1/alerts/{alertId}` - Returns specific alert details
- `/api/v1/silences` - Handles silence creation for alerts

The test will verify:
- Proper authentication with the token
- Correct parsing of API responses
- Error handling for various HTTP status codes
- Integration with Landflow's HTTP client patterns