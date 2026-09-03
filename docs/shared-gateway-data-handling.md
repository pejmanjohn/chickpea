# Shared Slack gateway data handling and delivery recovery

Chickpea's optional shared Slack app removes the need to create and configure your own Slack app. That convenience puts a Chickpea-operated gateway between Slack and your deployment. This document states the privacy and delivery contract for that path.

The short version: **the shared gateway does not durably store Slack message or event bodies**. It verifies and routes them in memory. On Cloudflare, your Chickpea deployment durably admits an event before the gateway acknowledges it, then removes the body as soon as processing completes or enters recovery. Slack remains the retry source during an outage.

This durable-admission and 48-hour deduplication contract currently applies to Cloudflare deployments. The Node target does not advertise durable admission to the shared gateway. Use your own Slack app for reliable Node ingress in v1.

## What is stored

| Location | Data | Retention |
|---|---|---|
| Shared gateway request handling | The Slack request body in transient process memory while the signature is checked, the event is routed, and the deployment receipt is awaited. | Not written to Durable Object storage, KV, R2, logs, or analytics. A live delivery receipt times out after 2 seconds. |
| Shared gateway installation state | Workspace, app, bot, installer, deployment, and binding identifiers; encrypted Slack installation tokens; granted scopes; health and session timestamps. | Until the workspace disconnects or Slack revokes the installation, subject to operational backup retention. This state contains credentials and identifiers, not message bodies. |
| Shared gateway retry-notice suppression | Workspace and channel identifiers for 5 minutes, plus Slack `event_id` for 25 hours. | Content-free records expire logically at those times and are removed by scheduled cleanup. They prevent duplicate offline notices. |
| Your Cloudflare deployment's inbox | The event envelope required to process a delivery, in the Durable Object state you operate. | Usually until processing completes. It is scrubbed immediately on completion, after the retry limit, or when recovery is required. An abandoned active delivery is scrubbed after at most 7 days. |
| Your Cloudflare deployment's deduplication record | Delivery ID, binding and workspace IDs, event kind, status, attempt count, timestamps, and a bounded reason code. No event or message body. | 48 hours after the row becomes terminal. Up to 1,000,000 protected rows are retained; if that bound is full, Chickpea rejects new admission instead of deleting an unexpired deduplication record. |
| Operational logs | Bounded reason codes and retry numbers, such as `session_missing` or `receipt_timeout`. | Controlled by the operator's log-retention policy. Message text, event envelopes, message-derived Slack fields, tool inputs and outputs, raw errors, and exception text are not part of the gateway delivery logs. |

Chickpea's normal transcript, memory, and run retention inside your deployment are separate product features. They follow the settings of the infrastructure you operate; the gateway does not receive a copy of that stored state.

## How delivery recovery works

1. Slack sends an Events API request to the shared gateway.
2. The gateway verifies the Slack signature and offers the event to the authenticated socket for the bound Chickpea deployment.
3. A Cloudflare deployment writes the delivery to its own durable inbox before returning `accepted` or `duplicate`.
4. Only then does the gateway acknowledge the request to Slack. Concurrent retries for the same delivery share the same pending receipt.
5. If no deployment session is available, the receipt times out, or admission is rejected, the gateway returns a failure. It does not acknowledge and discard the event.
6. Slack performs its normal retries. By default, Slack does not deliver events that are more than two hours late. When the shared Slack app's **Delayed Events** setting is enabled, events remain eligible regardless of age and Slack follows the ordinary retries with hourly retries for 24 hours. Slack describes the Events API as best effort. This gives Chickpea a 24-hour recovery window, not an exactly-once guarantee.
7. The Cloudflare deployment deduplicates by Slack's event identity. A retry can therefore recover a missed event without producing a second Agent run or reply.

Slack owns the event while it is waiting to retry. Slack's storage and deletion practices are governed by the workspace's Slack plan, settings, and Slack's own policies; Chickpea does not copy that waiting event into a gateway queue.

Delayed Events applies to Events API deliveries, including message events. Slack interactivity requests have different retry behavior and are not covered by this 24-hour recovery window.

Slack documents both the ordinary and delayed retry behavior in [The Events API](https://docs.slack.dev/apis/events-api/).

## Connection handoff and visible health

The deployment renews its outbound gateway connection before the old connection is retired. The gateway makes the authenticated successor delivery-capable, demotes the predecessor, and then closes it. If the candidate fails before it is ready, the predecessor remains active; if the predecessor has already disappeared, one ordinary reconnect resumes.

Admin reads live inbound-session health. A stored `healthy` value is shown as **Needs attention** when the current session is offline or belongs to an older Worker version. Reading health does not mutate installation state. On a late Slack retry, Chickpea may post one content-neutral offline notice, suppressed once per channel for 5 minutes and once per event for 25 hours.

## Choosing the privacy boundary

- **Shared Slack app on Cloudflare:** Chickpea operates the credential and routing gateway under the contract above. This is the easiest setup and preserves recovery without a durable gateway message queue.
- **Your own Slack app:** Slack sends requests directly to your deployment. The shared gateway and its installation state are absent from the path. This is the strongest infrastructure-isolation option and requires you to configure and operate the Slack app.

In either lane, model traffic and durable Agent state remain in the deployment and provider accounts you selected.

## Release and acceptance checklist

Code deployment alone does not enable Slack's delayed retry policy. Before treating the shared lane as outage-tolerant:

1. In the shared Slack app settings, open **Event Subscriptions** and enable **Delayed Events**.
2. Deploy matching gateway and Cloudflare Chickpea revisions.
3. Confirm Admin reports the shared Slack connection as **Connected** with healthy inbound delivery.
4. Send a disposable DM while the deployment session is intentionally unavailable for longer than Slack's ordinary retry sequence.
5. Restore the session, capture the actual `x-slack-retry-num` values on the delayed attempt, and verify exactly one Agent run and one reply for the original Slack `event_id`.
6. Verify the gateway logs contain only bounded reason codes and retry numbers, and that gateway storage contains no request body or message text.
7. Verify the deployment inbox has scrubbed the terminal payload and retained only the content-free deduplication row.

Until Delayed Events is enabled and this canary passes against the routed production app, the 24-hour recovery path is not proven live.
