# Slack Flue Vertical Slice Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the smallest Claude Tag-shaped Slack channel agent loop on Flue without Skillet, live Slack credentials, or Anthropic lock-in.

**Architecture:** Keep Slack install/assignment/dedupe/policy in app-owned code, and use one generic Flue agent module for the durable agent shape. Tests run against local Slack fixtures and deterministic provider adapters; real Slack and live model calls are opt-in later.

**Tech Stack:** TypeScript, Node test runner, Flue `@flue/runtime@1.0.0-beta.8`, `agents@0.17.1`, local in-memory stores, optional Cloudflare build.

---

## Current Findings

- Required repo docs say Slack is an assignment surface over reusable custom agents, not a separate Slack-only skill/tool model.
- Current Flue Cloudflare docs still generate one Durable Object class/binding per discovered agent/workflow plus `FlueRegistry`; canonical streams and accepted submissions live in generated DO SQLite, so product authority must stay app-owned.
- Current npm metadata: `@flue/runtime` and `@flue/cli` are `1.0.0-beta.8`, `agents` is `0.17.1`, and `@flue/slack` exists at `1.0.0-beta.1`.
- Scratch build proof with `@flue/runtime@1.0.0-beta.8` + `agents@0.17.1` succeeded for one Cloudflare agent and generated `FLUE_SLACK_THREAD_AGENT`, `FLUE_REGISTRY`, and an 8.5 MiB dry-run upload.
- `@flue/slack` is beta and the channels docs are marked AI-generated/awaiting review, so slice one uses an application-owned Slack fixture adapter and leaves a clean swap point.

## Files

- Create `package.json`, `package-lock.json`, `tsconfig.json`, `flue.config.ts`, `wrangler.jsonc`, `.gitignore`.
- Create `src/config/*` for seeded agents, channel assignments, and policy resolution.
- Create `src/slack/*` for local Slack app_mention fixtures, dedupe, thread keys, and reply sinks.
- Create `src/runtime/*` for session snapshots, provider selection, telemetry, and the Slack event runner.
- Create `src/tools/*` for one safe built-in tool plus allow/deny enforcement.
- Create `src/providers/*` for deterministic Claude and non-Claude provider adapters, with env-documented live-provider stubs.
- Create `src/agents/slack-thread.ts` as the generic Flue agent module that resolves dynamic config by instance id.
- Create `fixtures/slack/app-mention.json`.
- Create `tests/slack-thread-runner.test.ts`.
- Create `docs/decisions/2026-06-29-slack-flue-vertical-slice-decision.md`.

## Tasks

### Task 1: Scaffold and Tests

- [x] Add package/config files and a fixture.
- [x] Write failing tests for channel assignment, duplicate event handling, allowed/denied tools, provider selection, thread continuation, and first-visible-response telemetry.
- [x] Run tests and confirm the first failure is expected.

### Task 2: Local Product Contract

- [x] Implement assignment resolution from `workspace_id + channel_id` to one enabled custom agent.
- [x] Implement thread-scoped session start/continue keyed by Slack team/channel/thread timestamp.
- [x] Implement event-id dedupe before model/tool work.
- [x] Implement local Slack progress and final reply sinks.
- [x] Implement safe-tool allowlist checks that fail closed before execution.
- [x] Implement deterministic Claude and non-Claude provider adapters and telemetry.

### Task 3: Flue Shape

- [x] Add one generic Flue `src/agents/slack-thread.ts` module using async `defineAgent(({ id }) => ...)`.
- [x] Build a runtime config from the same app-owned assignment/snapshot policy.
- [x] Ensure the Flue module does not expose secrets, Slack tokens, or mutable assignment state to the model.
- [x] Run `npm run flue:build` to verify the Cloudflare target still generates cleanly.

### Task 4: Decision

- [x] Run `npm test`.
- [x] Write a short decision record: continue with Flue, pivot away, or continue with caveats.
- [x] Include the exact missing live gates: Slack signature route, Slack Web API posting, real Claude/non-Claude model credentials, generated DO state scan, and Cloudflare deployment smoke.

## Execution Decision

Proceed with this slice now. It is low-risk because it writes only this standalone repo, uses local fixtures by default, does not require Slack/model secrets, and keeps Flue adoption behind a generated-build proof plus a decision record.
