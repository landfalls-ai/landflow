/**
 * The written agent best practices (wave ag4, AG18): the text `read_agent_practices` returns to Spotlight's tool loops
 * and to MCP clients. The same text sits between the practices markers of `docs/platform/agent-best-practices.md`; a test
 * (tenant-catalog-ag4.test.ts) keeps the two equal.
 */
export const AGENT_PRACTICES = `## Best practices for building an agent

1. **One job per agent.** An agent has a single focus, named in its description in one sentence ("Reads an alert, finds the matching runbook and emails the on-call"). Two jobs make two agents. Before building, read the existing agents (\`list_agents\`): one that already covers the job is reused, not copied.
2. **The fewest tools that do the job.** Give an agent only the nodes it needs, found by what they do (\`list_tool_nodes\` with a query such as "IP addresses and domains in an alert"), never by guessing a node type. Every extra tool is another way to go wrong.
3. **Read before write.** The agent looks things up (an alert, a runbook, a record) before it sends, posts, creates or changes anything. Put the reads first in its steps.
4. **Asks first on every write.** A tool that sends, posts, creates, updates or deletes (\`writes: true\` in \`list_tool_nodes\`) is set to ask a person first, as Send Email is on the alert triager. Take it off only when the person says so.
5. **Instructions in four parts.** \`Input:\` what each message or item brings; \`Steps:\` numbered, naming the tools; \`Output:\` what it answers and how long; \`Hand over when:\` what it does not decide alone. Example: "Input: an alert text. Steps: 1. Extract the IP addresses and domains. 2. Search runbooks. Output: three lines. Hand over when: no runbook matches."
6. **Let the agent decide only what it must.** In a tool's parameters, fix what never changes (the sender, the table, the channel) and mark what the agent fills in per call with \`{{ $fromAI('key', 'what it is', 'string') }}\`. Never leave a person's address, name or id for the model to invent.
7. **Knowledge from a named folder or an existing base.** Attach a knowledge base that already exists (\`list_knowledge_bases\`) when it fits; otherwise index a folder the person named (for example \`runbooks\`). With no source given, ask: never pick a folder.
8. **Three to five real test cases.** Write the inputs themselves (the alert text, the question), each with what a right answer says. They run at the smoke test and at the eval gate before every publish.
9. **The model is the person's or the host's.** Use the model the person named when \`list_models\` lists it, else the host's default (\`isDefault\`), and say why. Never pick a bigger model on your own.
10. **Credentials are the person's pick.** \`list_credentials\` and \`list_tool_nodes\` show credentials by name and type only. Offer the one that fits ("Mailpit SMTP"); the person chooses, and a secret is typed only in the dialog the person opens. Never ask for, read or repeat a secret.
11. **Smoke test, then publish.** Run \`test_agent\` on a realistic message first. Publish only when it passes; the eval gate's hold stands and nothing skips it. A flow keeps running the version it was published with until a person publishes again.`;
