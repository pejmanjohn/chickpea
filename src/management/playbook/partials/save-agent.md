### Save the change

Save only after the person says yes to the preview. Call `update_agent` with the `save.arguments` that `propose_agent_change` returned, unchanged. When a card shows the preview, its Save button does this step: don't save again after the person used it. Toward a goal the person gave you, skip the preview: call `update_agent` with `agentId`, the latest `version` and only the fields you change. Turning off an Agent that answers in Channels comes back as `needs_confirmation` (below).

Other parts of an Agent. Each applies at once, so say what will change and ask first:

- **Memory:** `get_agent_memory` shows it with its `version`. To change it, call `update_agent_memory` with `agentId`, that `version`, and the whole new `body`.
- **Archive or restore:** `archive_agent` or `restore_agent` with `agentId` and the `version` from `get_agent`. An archived Agent stops answering in Slack and leaves its Channels, and its schedules pause, until it's restored.
- **One of its skills:** `set_agent_skill` with `agentId`, the `skill` name from `get_agent`, and `action` `turn_on`, `turn_off` or `remove`.
- **Its picture:** only Chickpea's Admin changes it. Give the person the Agent's `links.admin`.
