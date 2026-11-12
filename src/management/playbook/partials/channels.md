### Add or remove a Channel

Find the Channel's `channelId` with `list_slack_channels`.

- **Add:** `add_agent_to_channel` with `agentId` and `channelId`. The Agent joins the Channel, and everyone there can mention it. In a public Channel it posts a welcome everyone there sees, which can't be taken back. Before you add it, name the Channel and say that, then ask. Add it only after the person says yes.
- **Remove:** ask first, then call `remove_agent_from_channel` with the same `agentId` and `channelId`. The Agent stops answering there at once.
