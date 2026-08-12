const OPAQUE_MEMORY_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Identifiers safe to cross memory API, archive, and state RPC boundaries. */
export function isOpaqueMemoryId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_MEMORY_ID.test(value);
}

export function ownerMemoryStoreId(
  owner: { workspaceId: string; ownerKind: 'agent' | 'channel'; ownerId: string },
): string {
  if (![owner.workspaceId, owner.ownerId].every(isOpaqueMemoryId)) {
    throw new Error('Memory owner identifiers must be opaque IDs.');
  }
  return `memory_owner_${owner.ownerKind}_${owner.workspaceId}_${owner.ownerId}`;
}
