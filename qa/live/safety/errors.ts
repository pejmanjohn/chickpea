export function isNodeError(input: unknown): input is NodeJS.ErrnoException {
  return input instanceof Error && 'code' in input;
}
