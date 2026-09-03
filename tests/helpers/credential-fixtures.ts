// Credential-shaped test fixtures assembled at runtime.
//
// Public secret scanners (GitHub secret scanning, GitGuardian) match on literal
// PEM armor lines and on Amazon's documented example access keys, and they file
// alerts even when the surrounding bytes are obviously synthetic. Building the
// strings here keeps those literals out of the repository while the values the
// tests exercise stay byte-for-byte identical.

const ARMOR = '-'.repeat(5);

export function pemBegin(label: string): string {
  return `${ARMOR}BEGIN ${label}${ARMOR}`;
}

export function pemEnd(label: string): string {
  return `${ARMOR}END ${label}${ARMOR}`;
}

export function syntheticPem(label: string, body: readonly string[]): string {
  return [pemBegin(label), ...body, pemEnd(label)].join('\n');
}

// Amazon's documented example key ids: AKIA…/ASIA… + IOSFODNN7EXAMPLE.
export function awsExampleAccessKeyId(prefix: 'AKIA' | 'ASIA'): string {
  return prefix + ['IOSFODNN7', 'EXAMPLE'].join('');
}

// Amazon's documented example secret access key.
export const AWS_EXAMPLE_SECRET_ACCESS_KEY = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
