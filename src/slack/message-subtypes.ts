/** Content-bearing messages, excluding mutation wrappers and system events. */
export function isSlackContentMessageSubtype(subtype: string | undefined): boolean {
  // "Also send to channel/direct message" broadcasts the same thread reply.
  return !subtype || subtype === 'file_share' || subtype === 'thread_broadcast';
}

/**
 * Rows worth showing the model as conversation context: content messages
 * plus `bot_message`, which is how webhooks and legacy integrations (alerts,
 * CI, Workflow Builder) post. Triggers still use the stricter predicate
 * above: an app-authored message never starts a turn.
 */
export function isSlackContextMessageSubtype(subtype: string | undefined): boolean {
  return isSlackContentMessageSubtype(subtype) || subtype === 'bot_message';
}
