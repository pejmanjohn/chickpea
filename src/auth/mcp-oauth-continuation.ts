import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import type { BetterAuthDatabaseBackend } from './better-auth-backend.ts';

const CONTINUATION_TTL_MS = 10 * 60_000;
const AUTHORIZATION_PATH = '/api/auth/oauth2/authorize';

export interface McpOAuthContinuation {
  authorizationPath: string;
}

export interface IssuedMcpOAuthContinuation {
  id: string;
  expiresAt: number;
}

interface McpOAuthContinuationStoreOptions {
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

interface BetterAuthMcpOAuthContinuationStoreOptions extends McpOAuthContinuationStoreOptions {
  backend: BetterAuthDatabaseBackend;
}

interface StoredContinuation extends McpOAuthContinuation {
  expiresAt: number;
}

export class InMemoryMcpOAuthContinuationStore {
  private readonly continuations = new Map<string, StoredContinuation>();
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(options: McpOAuthContinuationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size));
  }

  issue(continuation: McpOAuthContinuation): IssuedMcpOAuthContinuation {
    const authorizationPath = validatedAuthorizationPath(continuation.authorizationPath);
    const id = Buffer.from(this.randomBytes(32)).toString('base64url');
    const expiresAt = this.now() + CONTINUATION_TTL_MS;
    this.continuations.set(id, { authorizationPath, expiresAt });
    return { id, expiresAt };
  }

  consume(id: string): McpOAuthContinuation | undefined {
    const stored = this.continuations.get(id);
    if (!stored) return undefined;
    this.continuations.delete(id);
    if (stored.expiresAt <= this.now()) return undefined;
    return { authorizationPath: stored.authorizationPath };
  }
}

export class BetterAuthMcpOAuthContinuationStore {
  private readonly now: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(private readonly options: BetterAuthMcpOAuthContinuationStoreOptions) {
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size));
  }

  async issue(continuation: McpOAuthContinuation): Promise<IssuedMcpOAuthContinuation> {
    const authorizationPath = validatedAuthorizationPath(continuation.authorizationPath);
    const id = Buffer.from(this.randomBytes(32)).toString('base64url');
    const createdAt = this.now();
    const expiresAt = createdAt + CONTINUATION_TTL_MS;
    await this.options.backend.putMcpOAuthContinuation({
      idHash: continuationHash(id),
      authorizationPath,
      expiresAt,
      createdAt,
    });
    return { id, expiresAt };
  }

  async consume(id: string): Promise<McpOAuthContinuation | undefined> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(id)) return undefined;
    const authorizationPath = await this.options.backend.consumeMcpOAuthContinuation(
      continuationHash(id),
      this.now(),
    );
    return authorizationPath ? { authorizationPath } : undefined;
  }
}

function validatedAuthorizationPath(value: string): string {
  if (typeof value !== 'string' || value.length > 4_096 || !value.startsWith(`${AUTHORIZATION_PATH}?`)) {
    throw new TypeError('MCP authorization path must be a local Better Auth authorization path.');
  }
  const parsed = new URL(value, 'https://chickpea.invalid');
  if (parsed.origin !== 'https://chickpea.invalid' || parsed.pathname !== AUTHORIZATION_PATH ||
      parsed.username || parsed.password || parsed.hash) {
    throw new TypeError('MCP authorization path must be a local Better Auth authorization path.');
  }
  return `${parsed.pathname}${parsed.search}`;
}

function continuationHash(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}
