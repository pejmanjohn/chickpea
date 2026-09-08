import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';

import { CliError } from './errors.ts';

export const CREDENTIALS_FILE = 'credentials.json';
const STORE_VERSION = 1;

export type StoredTokens = StoredOAuthTokens & {
  /** Absolute expiry in epoch milliseconds, derived from `expires_in` at save time. */
  expires_at?: number;
};

export interface StoredDeployment {
  origin: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredTokens;
  discovery?: OAuthDiscoveryState;
  updatedAt: string;
}

interface StoreFile {
  version: number;
  deployments: Record<string, StoredDeployment>;
}

/** `$XDG_CONFIG_HOME/chickpea` when set, otherwise `~/.config/chickpea`. */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, 'chickpea');
}

/**
 * One JSON file keyed by deployment origin. The directory is 0700 and the
 * file 0600; writes go through a temp file and rename so a crash never
 * leaves a half-written credential file behind.
 */
export class CredentialStore {
  constructor(readonly directory: string) {}

  get path(): string {
    return path.join(this.directory, CREDENTIALS_FILE);
  }

  read(origin: string): StoredDeployment | undefined {
    return this.load().deployments[origin];
  }

  list(): StoredDeployment[] {
    return Object.values(this.load().deployments);
  }

  write(entry: StoredDeployment): void {
    const file = this.load();
    file.deployments[entry.origin] = { ...entry, updatedAt: new Date().toISOString() };
    this.save(file);
  }

  delete(origin: string): boolean {
    const file = this.load();
    if (!(origin in file.deployments)) return false;
    delete file.deployments[origin];
    this.save(file);
    return true;
  }

  private load(): StoreFile {
    if (!existsSync(this.path)) return { version: STORE_VERSION, deployments: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      throw new CliError('STORE_CORRUPT', `Cannot parse ${this.path}`, 'Move the file aside and sign in again with: chickpea login <deployment-url>');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('STORE_CORRUPT', `Unexpected contents in ${this.path}`, 'Move the file aside and sign in again with: chickpea login <deployment-url>');
    }
    const file = parsed as Partial<StoreFile>;
    const deployments = file.deployments && typeof file.deployments === 'object' ? file.deployments : {};
    return { version: STORE_VERSION, deployments: { ...deployments } };
  }

  private save(file: StoreFile): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }
}

export function tokensExpired(tokens: StoredTokens | undefined, now: number, skewMs = 30_000): boolean {
  if (!tokens) return true;
  if (typeof tokens.expires_at !== 'number') return false;
  return tokens.expires_at - skewMs <= now;
}

export function withExpiry(tokens: StoredOAuthTokens, now: number): StoredTokens {
  const seconds = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
  return seconds === undefined ? { ...tokens } : { ...tokens, expires_at: now + seconds * 1_000 };
}
