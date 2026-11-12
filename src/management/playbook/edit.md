# Change an Agent

Most visits after the first one are edits. Show the person exactly what will change, save only after they say yes, and leave everything else about the Agent as it was.

<!-- include: rules -->

## 1. Find the Agent

Call `list_agents`. Match the Agent the person means by name, @handle or job. If two could match, ask which one. If `canEdit` is false for it, say who can change it (its creator or an Owner or Admin) and stop.

Call `get_agent` for the Agent as it is now. Keep the `version` it returns.

When the person describes a behavior to fix rather than a change to make ("it ignores half its tools", "its answers wander"), call `explain_agent` first: it shows what the Agent gets in a place, including any tool that is missing and why, and how much context its instructions, memory and tools use. Propose the change from that.

Connections and schedules are separate: see `get_guide` topic `connect` or `get_guide` topic `schedule`.

## 2. Preview the change

Work out the smallest change that does what the person asked:

- Behavior ("friendlier", "shorter answers", "never quote prices"): edit `instructions`. Change only the parts that need it and keep the rest of the text exactly as it was.
- Name, description or @handle: change only that field.
- Turning the Agent off or back on: `on`.
- Model, its effort, or the image model: pick from `list_models`, and change them only when the person asks.
- Who can edit it: `whoCanEdit`.

Call `propose_agent_change` with `agentId`, the `version` from `get_agent`, and `change` holding only those fields. It saves nothing. Show the person each change in place: the before and after of a short field, and the quotes it returns for an instructions edit, not the whole instructions. Say whether saving will need their confirmation (`needsConfirmation`). Then ask whether to save it.

If they want something different, propose again before saving.

<!-- include: save-agent -->

When the save succeeds, say what changed in one or two lines. If the result's `agent.status` is `off`, the Agent answers no one: don't practice or suggest a message. Say it's off, and offer to turn it on first.

Then check the change:

- **The person has test questions** for this Agent, in this conversation or in a file: pick the ones this change could affect, and test drive the Agent on only those (`get_guide` topic `test-drive`).
- **If your client shows Chickpea cards** and a card shows a "Try it again" button after a save: the person can press it to see the Agent's answer on the card. You are told only that an answer is shown. If they ask about that answer, or why the Agent said something, call `practice_agent` with `agentId` and no question. Within two minutes it returns the same run at no extra cost. Then read its `reply` and `steps`.
- **No test questions:** practice one question that shows the change. Say so first, and that it uses the workspace's usage like one Slack message. Call `practice_agent` with `agentId` and the question, then `get_practice_run` with its `runToken` until it is answered or failed. Show the answer, and offer to write test questions (`get_guide` topic `scope`).

Finish with one message to try in Slack and the result's `agent.links.slack`.

<!-- include: channels -->

<!-- include: confirm -->
