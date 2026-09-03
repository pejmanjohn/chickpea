import {
  exactKeys,
  fail,
  record,
} from './schema.ts';

export interface GitHubSourceBinding {
  repository: string;
  commit: string;
  path: string;
  digest: string;
}

export function validateGitHubSourceBinding(
  input: unknown,
  expectedDigest?: string,
): GitHubSourceBinding {
  const value = record(input, '$.source');
  for (const key of Object.keys(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (['command', 'dynamicimport', 'modulepath', 'filesystempath', 'setupcapability'].includes(normalized)) {
      fail('EXECUTABLE_FIELD', '$.source');
    }
  }
  exactKeys(value, ['repository', 'commit', 'path', 'digest'], '$.source');
  if (typeof value.repository !== 'string' || /^https?:\/\//i.test(value.repository)) {
    fail('FREEFORM_URL', '$.source.repository');
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value.repository)) {
    fail('INVALID_VALUE', '$.source.repository');
  }
  if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) {
    fail('SOURCE_NOT_PINNED', '$.source.commit');
  }
  if (typeof value.path !== 'string' || /^(?:\/|[A-Za-z]:\\|~\/)/.test(value.path)) {
    fail('ABSOLUTE_PATH', '$.source.path');
  }
  if (!/^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value.path)) {
    fail('INVALID_VALUE', '$.source.path');
  }
  if (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) {
    fail('INVALID_VALUE', '$.source.digest');
  }
  if (expectedDigest !== undefined && value.digest !== expectedDigest) {
    fail('SOURCE_DIGEST_MISMATCH', '$.source.digest');
  }
  return {
    repository: value.repository,
    commit: value.commit,
    path: value.path,
    digest: value.digest,
  };
}
