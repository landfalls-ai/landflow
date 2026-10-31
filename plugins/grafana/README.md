# Grafana Plugin

A Landflow plugin for interacting with the Grafana Alertmanager API.

## Overview

This plugin provides nodes to interact with Grafana's Alertmanager API, allowing you to:
- Get active alerts from Alertmanager
- Retrieve detailed information for specific alerts
- Acknowledge or silence alerts

## Nodes

### 1. Get Alerts (`getAlerts`)
Fetches active firing alerts from Grafana Alertmanager API.

### 2. Get Alert Details (`getAlertDetails`)
Retrieves detailed information for a specific alert by ID.

### 3. Acknowledge Alert (`acknowledgeAlert`)
Acknowledges or silences a specific alert.

## Credential

The plugin requires a credential of type `grafana_alertmanager_api_token` with:
- `baseUrl`: The base URL of the Grafana Alertmanager API endpoint (e.g., `http://localhost:9093`)
- `token`: The API token for authenticating with the Alertmanager API

## Installation

```bash
pnpm --filter @landflow/plugin-grafana install
```

## Development

To run in development mode:
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