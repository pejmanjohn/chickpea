# Agent lifecycle verification lessons

LC-01 uses a run marker in the requested Agent name. The marker lets the verifier find one durable Agent without keeping the original Slack transcript.

## Creation and welcome

Creation passes only when all of these records agree:

- the Agent exists once with `lifecycle: active`;
- its Slack presence has `desiredState: active` and `health: healthy`;
- the source Channel has an active grant for that Agent;
- one `agent_created_welcome` outbox targets the request thread and reaches `delivered`;
- the welcome publication is `complete` with an empty `incomplete` list;
- Slack history contains the delivered `message_ts` once in that thread;
- the durable activity projection is `cleared` or `not_required`.

A success-sounding welcome does not override a partial publication receipt. Missing presence or source-Channel publication fails the case even if the Agent record exists.

## Approval and full values

The update proposal must remain bound to the requester, Slack approval scope, thread, and Agent. A reaction is not bare approval. The verifier compares the full value in the durable proposal operation with the final Agent value. It does not compare against the bounded Slack preview.

The Agent revision must advance and the proposal result must name the same Agent and revision. Cleanup archives that immutable Agent ID, checks that no active route remains, and records only the declared run-marked tombstone.

## Known live limit

The deterministic adapter reads the product's durable `activityProjection`. The current QA target does not yet expose that record through an attested live observer, so live LC-01 must block instead of guessing from message text.

## Avatar and routing additions

LC-02 hashes the canonical source bytes and the published bytes. Admin and Slack URLs may differ because Slack can re-host an image. Screenshots and decoded-pixel similarity do not establish the canonical source digest. Live LC-02 stays blocked until one authenticated observer binds that digest to the Admin Agent and Slack persona revisions.

LC-03 grades `AgentThreadRoute`, active `AgentChannelGrant`, durable turn admission, target-version stability, and one terminal Slack delivery. Final reply text is not route proof. An explicit handoff must carry the previous Agent and transfer message. Ambiguous or unauthorized routing attempts must leave the route revision unchanged.

The route and persona facts currently exist only in internal durable projections. No authenticated read-only endpoint exposes them together, so live LC-03 stops before mutation.
