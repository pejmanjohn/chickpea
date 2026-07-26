const OPAQUE_MEMORY_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Identifiers safe to cross memory API, archive, and state RPC boundaries. */
export function isOpaqueMemoryId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_MEMORY_ID.test(value);
}
