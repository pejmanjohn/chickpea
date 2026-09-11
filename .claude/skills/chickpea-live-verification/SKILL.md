---
name: chickpea-live-verification
description: Verify Chickpea changes, core regressions, or release readiness using deterministic checks and real QA Slack journeys. Also use when maintaining this workflow.
---

# Chickpea live verification

Read `../../../qa/live/operator/SKILL.md` completely and follow it as the canonical workflow for this repository.

Default to its `changed` mode. A verification invocation authorizes the selected
mode's declared QA actions and exact cleanup, including test OAuth and product
approval dialogs. Do not ask the operator to approve each step again. Follow the
canonical skill's actual human-input and environment boundaries. A review or edit
of the skill alone does not start a live run.

Read the legacy coordinator runbook only when explicitly operating that
coordinator. Keep target coordinates, journals, transcripts, screenshots, and
evidence outside this repository.
