package landflow.tools

import rego.v1

# Landflow's tool access policy (docs/agents.md "Tool access"). Landflow asks once per tool before a run:
#   input = { caller: { id, role?, source }, agentId, tool, kind }
# and reads `result`: "allow", "ask" (a person approves first) or "deny" (the model never sees the tool).
# Point Landflow at it with LANDFLOW_TOOL_POLICY=opa and
#   LANDFLOW_TOOL_POLICY_URL=http://127.0.0.1:58181/v1/data/landflow/tools
# This file is an example: edit the rules, the agent's own rules still apply as well and the most restrictive answer wins.
default result := "allow"

# Only the users listed in data.landflow.refunders (data.json) may use a tool named refund_order.
result := "deny" if {
	input.tool == "refund_order"
	not input.caller.id in data.landflow.refunders
}

# Anything a schedule or a chat app starts may not send email.
result := "deny" if {
	input.tool == "send_email"
	input.caller.source in {"schedule", "telegram", "slack", "teams"}
}

# Reading orders from the builder's test chat needs a person's approval.
result := "ask" if {
	input.tool == "read_orders"
	input.caller.source == "test"
}
