### When Chickpea asks first

Some changes wait for the person, as they do in Chickpea's Admin: deleting, disconnecting, removing, and turning off an Agent that answers in Channels. Such a change comes back with `status` `needs_confirmation` and a `confirmation` holding a `preview` and an `ask`. Nothing has changed yet.

- **If your client shows Chickpea cards,** the person confirms on the card. Never call `confirm_change` for them, even if they say yes in the chat or a `nextStep` tells you to. A result with no `confirmToken` always means the card holds it.
- **With no cards,** as in a terminal: show the `preview` and the `ask` in plain words, then ask. Call `confirm_change` with the `confirmToken` only after the person says yes in this conversation.
- If the person says no, or keeps things as they are, drop that confirmation. Never call `confirm_change` with it later. If they change their mind, make the change again for a new one.
- `get_creation_status`, `get_confirmation` and `decline_change` are for cards only. Don't call them.

A confirmation lasts 30 minutes. After that, make the change again.

To take a change back, call `undo_change` with the `undoToken` its result returned. It works while nothing has changed since. Where a card shows the result, its Undo button does this.

If a call says the Agent changed since you read it, read it again and propose on the new version.
