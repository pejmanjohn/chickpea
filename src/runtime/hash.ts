export function stableHash(input: unknown): string {
  const json = JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort());
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;

  for (let index = 0; index < json.length; index += 1) {
    hash ^= BigInt(json.charCodeAt(index));
    hash *= prime;
    hash &= 0xffffffffffffffffn;
  }

  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
