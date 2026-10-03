# Agents: create, welcome, instructions, archive

Docs: `/agents/agents/`, `/agents/create-an-agent/`, `/agents/instructions/`, `/slack/manage-from-slack/`. Record areas: `agents`, `delivery`. Legacy contracts: LC-01, LC-02, LC-03 (archive and restore variant).

## What it covers

- Creating an Agent from Slack, Admin or the management MCP. Slack and MCP creation apply at once with no proposal, unless the edit policy is "any workspace member".
- Reach at creation: a channel request grants that channel only, a DM request grants none, an MCP create grants none, and an Admin create is a draft until a channel is attached.
- The welcome: the new Agent introduces itself in the request thread under its own name, handle and avatar, with a **View Agent** link and up to three **Connect X** links for connectors the request named.
- The first teammate: a person who describes their team to `@Chickpea` gets three starters from a catalog of five, and a numbered reply creates that one immediately with a welcome. It works in direct messages until someone publishes it.
- Instruction changes: an instructions-only change applies at once with an undo. A compound change, or one that widens capability, reach or edit authority, returns one frozen proposal with a visible diff.
- Approval: the same person, in the same thread, replies with exactly `approve` (or `approved`, `confirm`, `apply it`, `apply this`, `create it`, `create this`), or presses the proposal card's **Approve**. **Cancel** retires the proposal.
- Archive and restore: archiving disables the handle, removes channel access and pauses schedules; restoring puts back the snapshot taken at archive. Asked in Slack, both come back as proposals.
- Avatars: a new Agent gets one of twelve shipped images, least-used first. Uploading one in Admin replaces it and the record reads `uploaded`.
- Managing from Slack: `@Chickpea` edits any Agent the person may edit. An Agent mentioned by its handle manages itself and hands cross-Agent work back to `@Chickpea`.
- A refused handle keeps the Agent and shows **Retry** beside the exact fix (user-group policy, paid plan, collision, two-factor).

## How a person reaches it

- Slack: mention `@Chickpea` in the channel where the Agent should work and describe the job; for an edit, mention the Agent or `@Chickpea` and approve in the same thread.
- Admin: **Agents → New Agent** (`/admin/agents/new`), then **Choose first channel**. The profile's overflow menu holds **Archive Agent** and **Restore Agent**; the avatar is changed only on the Agent page.
- MCP: one `create_agent` operation in `apply_workspace_changes`. Publishing is a separate `grant_agent_channel` operation, and other changes are proposals confirmed with `confirm_workspace_change`.

## How to drive it on a lane

- Use one disposable Agent per case group, named with the run marker (for example `Calendar QA <run marker>`), and a fresh thread per case. Credential-backed cases run on the lane's `qa-fixtures` Agent instead.
- The template already has `create-welcome` and `instruction-approval`. Add archive-restore, avatar and MCP-create cases with `case-add`:

```sh
npm run verify:live:record -- case-add --spec "$run_dir/spec.json" --output "$run_dir/spec-2.json" \
  --case archive-restore --title "Archive and restore" --context candidate \
  --area agents --area delivery --require candidate.owner --require candidate.channel \
  --proof slack --proof admin --max-wait-ms 120000 \
  --original-request "Archive the run Agent, then restore it and ask it for the run marker." \
  --expected-outcome "Archived: no answer and no fallback Agent. Restored: the same handle answers as itself." \
  --cleanup-contract "Archive the run-owned Agent and verify no grants and no DM access."
```

- Create from Slack in the lane's QA channel. Admin creation followed by attaching a channel does not exercise the welcome path.
- For the instruction case, mention the new Agent's own handle in a fresh thread, ask for a complete bounded change, confirm nothing saved before approval, reply only `approve`, then reload Admin and compare the saved text, newlines included.
- Register every Agent the moment Admin shows its ID: `record resource --case <case> --provider chickpea --kind agent --resource-id <agent id> --ownership owned --cleanup-preset archived-agent --evidence <readback>`. Cleanup is archive, not delete.

## Proof and gotchas

- Creation passes only when Admin shows one active Agent with a healthy handle and an active grant for the source channel, and the request thread holds exactly one welcome. Record the Agent ID from Admin, never from the display name.
- Approval proof is the full saved value against the frozen proposal. The Slack preview may truncate; it is not the comparison.
- The approval word must be the whole reply. A longer sentence reaches the Agent as conversation, and an approval from another person or thread applies nothing.
- A welcome can succeed while a bad model pin breaks the first real request. Send one real request and check the model in the reply footer.
- Insert mentions with Slack's mention control and confirm the draft holds a mention token. A plain-text `@handle` reaches no Agent, so its silence proves nothing.
- An Admin-created Agent answers nowhere until it has a channel; a plain `@handle` typed before that goes to `@Chickpea`.
- A change applies from the next admitted event, also in an open thread, and the thread keeps its transcript. A reply already running finishes on its old plan, so send a new message to see the change.
- Read the whole welcome. An earlier build leaked a raw revision-conflict error into it.
- An Agent with live thread snapshots cannot be deleted. Archive it, and verify `lifecycle: archived`, zero channels and no DM access.
- Avatar parity compares the Slack sender, the Admin profile and the Admin roster. Slack may re-host the image, so differing URLs are not a failure, and a screenshot alone does not prove the canonical asset.
- An archived Agent must not answer or fall back to another Agent; after restore the same handle and persona answer again.
- Asked in Chickpea's DM for a new Agent with a schedule, Chickpea creates the Agent at once and the schedule rides in the welcome's proposal. The typed `approve` is applied by Chickpea although the thread now belongs to the new Agent. No "I couldn't complete that scheduled-work action." receipt and no **Connect** link the request did not name (a weekday is not Monday.com).
- The creation turn's run stays `executing` in Sessions because the deferred welcome never finalizes it, and some delivered replies do too. A run's status is not delivery proof; read Slack.
- Admin session diagnostics (`/admin/api/sessions/<run>?diagnostics=1`) show each execution's `flueInstanceRef`. A host-applied approval shows `not_invoked` with null references. DM interactive runs are listed there; only DM schedules are private.
- `lane:slack thread` can return only the root of a Chickpea DM thread. Read DM replies from the lane browser's thread pane.
