import { timingSafeEqual } from 'node:crypto';

export function constantTimeEquals(
  candidate: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!candidate || !expected) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer);
}
