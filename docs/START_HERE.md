# Slack Flue Prototype - Start Here

This folder is a seed pack for a standalone Flue prototype, independent of
Skillet. The copied files are source context, not implementation instructions to
follow blindly.

## Prototype Goal

Build a Claude Tag-shaped Slack workspace prototype without Anthropic lock-in:

1. A Slack `app_mention` starts or continues a thread-scoped agent session.
2. Direct messages respond without mention syntax.
3. Public-channel thread replies can continue without another mention only after the bot has already joined that thread through a process-local session.
4. The Slack workspace/channel resolves to a configured custom agent.
5. Flue owns the agent harness/session loop.
6. The app owns Slack install state, channel assignment, access policy, billing
   or usage gates, audit, and secrets.
7. The same task can run on Claude and at least one non-Claude model.

## Source Map

### Product Target

- `docs/source/claude-tag/2026-06-26-claude-tag-research.md`

Use this as the target product model: Slack mention, scoped persistent work
session, access bundles, progress replies, final replies, and an "open session"
web handoff.

### Custom Agents and Slack Assignment

- `docs/source/skillet-custom-agents/2026-06-26-001-feat-skillet-slack-agent-cloudflare-plan.md`
- `docs/source/skillet-custom-agents/custom-agents.md`
- `docs/source/skillet-custom-agents/2026-06-26-custom-agent-runtime-spike.md`
- `docs/source/skillet-custom-agents/2026-06-26-003-feat-model-runtime-support-registry-plan.md`
- `docs/source/skillet-custom-agents/2026-06-27-002-feat-custom-agent-mcp-connections-plan.md`

Reuse the product split: custom agents are the reusable definition layer;
Slack is an assignment/deployment surface. Preserve the useful constraints:
immutable per-session snapshots, owner-approved tools, model/runtime support
rules, and fail-closed behavior when a runtime or assignment is missing.

Do not copy Skillet's exact route names, D1 schema, billing model, or UI
structure unless the new prototype independently needs them.

### Flue and Harness Migration Learnings

- `docs/source/skillet-flue/2026-06-29-001-feat-flue-office-hours-migration-spike-plan.md`
- `docs/source/skillet-flue/2026-06-27-agent-harness-api-fit.md`
- `docs/source/skillet-flue/2026-06-27-standard-agent-harness-decision.md`
- `docs/source/skillet-flue/agent-observability.md`
- `docs/source/skillet-flue/2026-06-23-cloudflare-agent-runtime-threat-model.md`

Reuse the evaluation discipline: generated-target audit first, then bridge
tests, then real Slack/product canaries, state/secret inspection, usage
telemetry, rollback, and model comparison.

The important architectural lesson is that Flue is a framework lane, not a
layer stacked on top of Project Think. Evaluate this prototype as Flue plus
Cloudflare, with Pi as part of Flue's internals, not as Skillet's old custom
harness plus Think plus Flue.

### Evaluation Patterns

- `docs/source/skillet-evals/office-hours-standard-harness-comparison.md`
- `docs/source/skillet-evals/office-hours-runtime-comparison.md`

Reuse the comparison shape, not the Office Hours details. For this project,
the equivalent gates should compare:

- Slack event ingress and dedupe.
- Channel assignment resolution.
- Thread continuation behavior.
- Tool/access policy enforcement.
- Progress and final Slack replies.
- Web session handoff.
- Claude versus non-Claude model behavior.
- Time to first visible Slack response.

## Suggested First Build Slice

Build the smallest vertical slice in a fresh Flue app:

1. One hardcoded workspace, channel, and custom agent config.
2. One Slack `app_mention` route with signature verification or a local signed
   fixture harness.
3. Generic Slack `message` event admission for public thread continuations and DMs, with top-level ambient channel messages ignored.
4. Bounded Slack context hydration: `conversations.replies` for active threads/DMs and `conversations.history` only for explicit top-level mentions.
5. One generic Flue agent module that loads dynamic agent config by id.
6. One safe built-in tool, with explicit allow/deny tests.
7. Threaded Slack progress and final replies.
8. A local web page that can open the same session transcript.
9. A provider switch test that runs the same fixture on Claude and a non-Claude
   model.

## Decision Gates

Continue with Flue if:

- Dynamic DB-configured agents fit cleanly through one generic Flue agent module.
- Slack event routing can dispatch to continuing Flue agent sessions without
  reimplementing most of the harness outside Flue.
- Slack `message.channels` and `message.im` admission remains narrowly filtered: no top-level ambient channel replies, no bot/self loops, no private-channel or MPIM expansion without a deliberate config decision.
- Access policy and secrets stay outside model-visible state.
- Usage, latency, and tool events are observable enough for staff canary.

Stop or pivot if:

- Flue requires one generated source-file agent per user-created custom agent.
- Flue-owned state becomes the product authority for assignments, secrets, or
  billing.
- Slack/channel policy must be custom-built outside Flue with little remaining
  harness benefit.
- The prototype cannot prove a non-Claude model lane.
