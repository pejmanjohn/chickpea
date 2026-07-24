const GITHUB_GIT_HOST = 'github.com';
const GITHUB_API_HOST = 'api.github.com';

/**
 * Build the credential header for an already-authorized GitHub request.
 * Callers must enforce repository grants before calling this helper.
 */
export function githubAuthorizationHeader(url: string, token: string): string {
  const host = new URL(url).hostname.toLowerCase();
  if (host !== GITHUB_GIT_HOST && host !== GITHUB_API_HOST) {
    throw new Error('Unsupported GitHub credential host');
  }
  if (host === GITHUB_GIT_HOST) {
    // Git Smart HTTP authenticates the installation token as the password;
    // Bearer is valid for REST but GitHub rejects it on upload/download-pack.
    return `Basic ${btoa(`x-access-token:${token}`)}`;
  }
  return `Bearer ${token}`;
}
