// Typed config errors so route boundaries classify failures with instanceof
// instead of matching message substrings authored in other modules (which
// silently break on rewording).

// The constructor args are kept as readonly fields so boundaries that must
// SERIALIZE these errors (the state Durable Object's RPC envelope) can carry
// the args and reconstruct the identical error on the other side — never by
// parsing them back out of the message.

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

export class AgentStillAssignedError extends Error {
  constructor(
    readonly agentId: string,
    readonly keys: string,
  ) {
    super(`Agent ${agentId} is still assigned to ${keys}`);
    this.name = 'AgentStillAssignedError';
  }
}

export class AgentStillSlackDmHandlerError extends Error {
  constructor(
    readonly agentId: string,
    readonly identityIds: string,
  ) {
    super(`Agent ${agentId} handles Slack DMs for ${identityIds}`);
    this.name = 'AgentStillSlackDmHandlerError';
  }
}

export class AgentStillReferencedError extends Error {
  constructor(readonly agentId: string, readonly references: string) {
    super(`Agent ${agentId} is still referenced by ${references}`);
    this.name = 'AgentStillReferencedError';
  }
}

export class AgentSlackIdentityConflictError extends Error {
  constructor(
    readonly agentId: string,
    readonly expectedIdentityId: string | null,
    readonly actualIdentityId: string | null,
  ) {
    super(
      `Agent ${agentId} changed Slack identity (expected ${expectedIdentityId ?? 'workspace default'}, actual ${actualIdentityId ?? 'workspace default'})`,
    );
    this.name = 'AgentSlackIdentityConflictError';
  }
}

export class UnknownSlackIdentityError extends Error {
  constructor(readonly identityId: string) {
    super(`Unknown Slack identity ${identityId}`);
    this.name = 'UnknownSlackIdentityError';
  }
}

export class SlackIdentityExistsError extends Error {
  constructor(readonly identityId: string) {
    super(`Slack identity ${identityId} already exists`);
    this.name = 'SlackIdentityExistsError';
  }
}

export class SlackIdentityStillReferencedError extends Error {
  constructor(
    readonly identityId: string,
    readonly agentIds: string,
    readonly dmAgentId: string,
  ) {
    const references = [
      agentIds ? `Agents ${agentIds}` : '',
      dmAgentId ? `DM Agent ${dmAgentId}` : '',
    ].filter(Boolean);
    super(
      `Slack identity ${identityId} is still referenced${references.length ? ` by ${references.join(' and ')}` : ''}`,
    );
    this.name = 'SlackIdentityStillReferencedError';
  }
}

export class SlackIdentityRevisionConflictError extends Error {
  constructor(
    readonly identityId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Slack identity ${identityId} changed (expected revision ${expectedRevision}, actual ${actualRevision})`,
    );
    this.name = 'SlackIdentityRevisionConflictError';
  }
}

export class SlackIdentityLifecycleError extends Error {
  constructor(
    readonly identityId: string,
    readonly action: string,
    readonly lifecycle: string,
  ) {
    super(`Cannot ${action} Slack identity ${identityId} while it is ${lifecycle}`);
    this.name = 'SlackIdentityLifecycleError';
  }
}

export class WorkspaceDefaultSlackIdentityProtectedError extends Error {
  constructor(readonly action: string) {
    super(`Cannot ${action} the workspace-default Slack identity`);
    this.name = 'WorkspaceDefaultSlackIdentityProtectedError';
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
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}
