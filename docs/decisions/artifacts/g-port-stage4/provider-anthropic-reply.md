# Provider reply — anthropic (STUB)

- **Provenance:** STUB. `ANTHROPIC_API_KEY` is ABSENT in this environment
  (not in the shell env, not in `.env.slack.local`). Per the brief, an absent
  cred runs against a protocol-faithful `anthropic-messages` SSE stub.
- **Model:** `anthropic/claude-haiku-4-5` (via `SLACK_FLUE_MODEL`).
- **Provider wire protocol:** `POST <base>/v1/messages` streaming SSE
  (`message_start` → `content_block_delta` → `message_stop`). Wire methods observed: `messages`.
- **Routing:** the SAME `app-mention.json` fixture, answered through the Flue
  lane by swapping only `SLACK_FLUE_MODEL`.

## Reply delivered on the Slack wire

```
ANTHROPIC_STUB_REPLY::haiku-4-5::exec-priorities-ack
```
