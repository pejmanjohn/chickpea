import type { BetterAuthOptions } from 'better-auth';

export interface BetterAuthDatabaseBackend {
  database: NonNullable<BetterAuthOptions['database']>;
  absoluteExpiryForToken(token: string): Promise<Date | null>;
  hasPasswordCredential(email: string): Promise<boolean>;
}
