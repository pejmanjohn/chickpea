import { createHash } from 'node:crypto';

export function sha256HexNode(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value.slice();
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
