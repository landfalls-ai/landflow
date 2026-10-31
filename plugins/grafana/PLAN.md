# Grafana Plugin Plan

## Package Information
- **Package name**: `@landflow/plugin-grafana`
- **Plugin ID**: `grafana`
- **HTTP port**: 7102 (next available)
- **gRPC port**: 7202 (next available)

## Credential Type
- **Credential type**: `grafana_alertmanager_api_token`
- **Fields**:
  - `url`: Grafana Alertmanager API base URL (required)
  - `token`: API token for authentication (required)

## Nodes and Operations

### 1. Get Alerts
- **Node name**: `getAlerts`
- **Operation**: Fetches active firing alerts from Grafana Alertmanager API
- **HTTP method**: GET
- **Path**: `/api/v2/alerts?active=true&silenced=false&inhibited=false`
- **Description**: Retrieves currently firing alerts that are not silenced or inhibited

### 2. Get Alert Details
- **Node name**: `getAlertDetails`
- **Operation**: Retrieves detailed information for a specific alert by its ID
- **HTTP method**: GET
- **Path**: `/api/v2/alerts/{alertId}`
- **Description**: Gets complete details for a specific alert by its unique identifier

### 3. Acknowledge Alert
- **Node name**: `acknowledgeAlert`
- **Operation**: Acknowledges or silences a specific alert in Grafana Alertmanager
- **HTTP method**: POST
- **Path**: `/api/v2/silence`
- **Description**: Creates a silence for the specified alert to prevent further notifications

## Files to Write

1. `plugins/grafana/package.json` - Plugin package definition
2. `plugins/grafana/src/main.ts` - Main plugin entry point
3. `plugins/grafana/src/nodes/get-alerts.ts` - Get alerts node
4. `plugins/grafana/src/nodes/get-alert-details.ts` - Get alert details node
5. `plugins/grafana/src/nodes/acknowledge-alert.ts` - Acknowledge alert node
6. `plugins/grafana/test/get-alerts.test.ts` - Test for get alerts node
7. `plugins/grafana/test/get-alert-details.test.ts` - Test for get alert details node
8. `plugins/grafana/test/acknowledge-alert.test.ts` - Test for acknowledge alert node

## Test Plan

Each test will:
- Run against a fake HTTP server
- Verify the correct HTTP method and path are called
- Verify authentication headers are properly set with the API token
- Verify the parsed output matches expected structure