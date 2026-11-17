# landflow-dev

Skills and agents that teach Claude how to work with Landflow: where things live, how the host is layered, how to write
a node plugin, and how the deployment fits together. They point at the people's pages in
[`docs/platform/`](../../docs/platform/README.md) instead of repeating them.

## What it gives

Skills (in `skills/`, one job each):

| Skill | Use it to |
|---|---|
| `landflow-platform-overview` | find your way: what Landflow is, where code and docs are, how a run works |
| `landflow-server-change` | change the host (`apps/web`): routes, migrations, access rules, tests, docs |
| `landflow-agents` | work on agents: the in-host loop, kagent, personas, teams |
| `landflow-kubernetes` | read or change the Kubernetes layout, overlays and local OrbStack deploy |
| `landflow-plugin-typescript` | write a node plugin with `@landflow/sdk` |
| `landflow-plugin-python` | write a node plugin with `landflow_sdk` |
| `landflow-plugin-go` | write a node plugin with the Go SDK |

Agents (in `agents/`):

| Agent | Does |
|---|---|
| `landflow-platform-guide` | answers questions about the architecture, server layers, agents, Kubernetes and SDKs, read-only, citing files |
| `landflow-plugin-builder` | builds a node plugin end to end in TypeScript, Python or Go from a request |

## Install

In a repository that builds on Landflow:

```
/plugin marketplace add landfalls-ai/landflow
/plugin install landflow-dev@landflow-soc
```

Each skill works without a local copy of the docs: it checks for `docs/platform/` and otherwise reads the same pages on
GitHub.

## Inside the Landflow repository

Nothing needs installing. The same skills and agents are copied into `.claude/skills/` and `.claude/agents/`, and Claude
Code loads them when you open the repository. This folder is the source: edit here, then run
`node scripts/sync-claude-plugin.mjs --write` (`pnpm check:claude-plugin` fails when a copy differs).
