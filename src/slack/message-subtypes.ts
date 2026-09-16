/** Content-bearing messages, excluding mutation wrappers and system events. */
export function isSlackContentMessageSubtype(subtype: string | undefined): boolean {
  // "Also send to channel/direct message" broadcasts the same thread reply.
  return !subtype || subtype === 'file_share' || subtype === 'thread_broadcast';
}
