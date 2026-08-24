// Typed config errors so route boundaries classify failures with instanceof
// instead of matching message substrings authored in other modules (which
// silently break on rewording).

// The constructor args are kept as readonly fields so boundaries that must
// SERIALIZE these errors (the state Durable Object's RPC envelope) can carry
// the args and reconstruct the identical error on the other side — never by
// parsing them back out of the message.

import type { AgentIdentityField } from './agent-id.ts';

export class UnknownAgentError extends Error {
  constructor(readonly agentId: string) {
    super(`Unknown agent ${agentId}`);
    this.name = 'UnknownAgentError';
  }
}

export class AgentExistsError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} already exists`);
    this.name = 'AgentExistsError';
  }
}

export class AgentRevisionConflictError extends Error {
  constructor(
    readonly agentId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Agent ${agentId} changed (expected revision ${expectedRevision}, actual ${actualRevision})`,
    );
    this.name = 'AgentRevisionConflictError';
  }
}

export class ReservedAgentIdentityError extends Error {
  constructor(readonly field: AgentIdentityField) {
    super(`The Agent ${field} is reserved for Chickpea`);
    this.name = 'ReservedAgentIdentityError';
  }
}

export class WorkspaceModelDefaultRevisionConflictError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Workspace default ${workspaceId} changed ` +
      `(expected revision ${expectedRevision}, actual ${actualRevision})`,
    );
    this.name = 'WorkspaceModelDefaultRevisionConflictError';
  }
}

export class AgentStillAssignedError extends Error {
  constructor(
    readonly agentId: string,
    readonly keys: string,
  ) {
    super(`Agent ${agentId} is still assigned to ${keys}`);
    this.name = 'AgentStillAssignedError';
  }
}

export class AgentStillReferencedError extends Error {
  constructor(readonly agentId: string, readonly references: string) {
    super(`Agent ${agentId} is still referenced by ${references}`);
    this.name = 'AgentStillReferencedError';
  }
}

export class ChannelRevisionConflictError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly channelId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Channel ${workspaceId}/${channelId} changed (expected revision ${expectedRevision}, actual ${actualRevision})`,
    );
    this.name = 'ChannelRevisionConflictError';
  }
}

// "Nothing enabled answers in this channel" — the resolver's not-found family.
export class NoAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAssignmentError';
  }
}

// Assigned but disabled: still "nothing answers here", so it subclasses
// NoAssignmentError and any instanceof NoAssignmentError check covers both.
export class DisabledAgentError extends NoAssignmentError {
  constructor(agentId: string) {
    super(`Assigned agent ${agentId} is disabled`);
    this.name = 'DisabledAgentError';
  }
}

export class ModelResolutionError extends Error {
  constructor(
    message: string,
    readonly repair?: {
      status: 'provider_setup_required' | 'unsupported';
      providerId: string;
      path: string;
    },
  ) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}
