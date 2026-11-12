# 5.0 tool listings

`get-agent-output-ab65a0d30.json` is `get_agent`'s output schema as Core
listed it at `ab65a0d30`, the release before `get_agent` gained a catalog MCP
service's `tools` (#748). It is
`getAgentOutput['~standard'].jsonSchema.output({ target: 'draft-2020-12' })`
evaluated in that commit's tree, which is what the MCP SDK lists.
`tests/management-mcp-v5-open-output-schemas.test.ts` checks a result against
it as a client that kept that listing would.

`card-host-tools.json` is the sha-256 of each tool descriptor a client that
draws cards lists, in order, over its JSON with keys sorted.
`tests/management-mcp-v5-card-host-tools.test.ts` checks the listing against
it, so removing the 4.x surface cannot change what OpenAI reviews. Rewrite it
with `CHICKPEA_UPDATE_CARD_HOST_TOOLS=1` only for a change you mean to make.
