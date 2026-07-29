# Interactive usage capture

Implemented for the usage observability rollout on 2026-07-28.

- `USAGE_RUNTIME_RECORDING=1` enables runtime recording independently of estimates and the Admin Usage page.
- A claimed Slack message key is the idempotent work-instance ID. Each actual relay attempt receives a distinct execution ID; retrying persistence reuses that ID.
- Admission freezes installation, workspace, profile, named-channel or generic-DM, requested model/provider, and opaque credential epoch. No prompt, response, instruction, tool, or header content enters the ledger.
- Aggregate input/output/total units and returned model identity come only from the bounded Flue result contract. Missing or all-zero adapter usage is `not_reported`, never free usage.
- Terminal telemetry is attempted before Slack delivery with a 100 ms budget capped at 250 ms. A timeout or failure cannot block delivery. The Cloudflare turn job records the gap as its independent denominator, then makes at most one post-delivery repair without re-running the model.
- Model execution status and Slack delivery status stay separate. A Slack delivery failure does not erase already-recorded provider work.
- The flag defaults off for staged rollout. Disabling it does not remove existing ledger rows.
