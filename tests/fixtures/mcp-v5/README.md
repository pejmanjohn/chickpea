# 5.0 tool listings from earlier releases

`get-agent-output-ab65a0d30.json` is `get_agent`'s output schema as Core
listed it at `ab65a0d30`, the release before `get_agent` gained a catalog MCP
service's `tools` (#748). It is
`getAgentOutput['~standard'].jsonSchema.output({ target: 'draft-2020-12' })`
evaluated in that commit's tree, which is what the MCP SDK lists.
`tests/management-mcp-v5-open-output-schemas.test.ts` checks a result against
it as a client that kept that listing would.
