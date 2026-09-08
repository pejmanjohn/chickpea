export function randomSecret(
  randomBytes: (length: number) => Uint8Array,
  length: number,
): string {
  return Buffer.from(randomBytes(length)).toString('base64url');
}
