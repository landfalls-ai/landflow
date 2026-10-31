# Grafana Alertmanager Plugin

A Landflow plugin for interacting with the Grafana Alertmanager API.

## Nodes

### Get Alerts (`getAlerts`)
Fetches active firing alerts from Grafana Alertmanager API.

**Parameters:**
- `alertmanagerUrl` (string, required): Base URL of the Grafana Alertmanager API
- `apiToken` (string, required): Authentication token for the Alertmanager API

### Get Alert Details (`getAlertDetails`)
Retrieves detailed information for a specific alert by its ID.

**Parameters:**
- `alertmanagerUrl` (string, required): Base URL of the Grafana Alertmanager API
- `apiToken` (string, required): Authentication token for the Alertmanager API
- `alertId` (string, required): ID of the alert to retrieve details for

### Acknowledge Alert (`acknowledgeAlert`)
Acknowledges or silences a specific alert in Grafana Alertmanager.

**Parameters:**
- `alertmanagerUrl` (string, required): Base URL of the Grafana Alertmanager API
- `apiToken` (string, required): Authentication token for the Alertmanager API
- `alertId` (string, required): ID of the alert to acknowledge/silence
- `silence` (boolean, optional): If true, silence the alert; if false, just acknowledge it (default: false)

## Installation

```bash
pnpm --filter @landflow/plugin-grafana install
```

## Usage

The plugin provides three nodes that can be used in Landflow workflows to interact with Grafana Alertmanager API.

## Development

To run the plugin in development mode:

```bash
cd plugins/grafana
pnpm dev
```

To run tests:

```bash
cd plugins/grafana
pnpm test
```

To typecheck:

```bash
cd plugins/grafana
pnpm typecheck
```