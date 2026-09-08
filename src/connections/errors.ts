/** Credential absence is distinct from a failed authorization fence. */
export class ConnectionCredentialUnavailableError extends Error {
  constructor() {
    super('Connection account authorization is unavailable');
    this.name = 'ConnectionCredentialUnavailableError';
  }
}
