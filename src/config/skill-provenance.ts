import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as v from 'valibot';
import type { SkillConfig } from './types.ts';

export const skillImportSourceSchema = v.strictObject({
  repository: v.pipe(v.string(), v.maxLength(256), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  commit: v.pipe(v.string(), v.regex(/^[a-f0-9]{40,64}$/)),
  path: v.pipe(v.string(), v.maxLength(1024), v.check((path) =>
    !path.startsWith('/') && !path.split('/').some((part) => part === '..'))),
  contentSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

export function skillImportSource(
  repository: string,
  commit: string,
  path: string,
  skill: Pick<SkillConfig, 'name' | 'description' | 'instructions'>,
): NonNullable<SkillConfig['importSource']> | undefined {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) return undefined;
  return v.parse(skillImportSourceSchema, {
    repository, commit: commit.toLowerCase(), path: path === '(root)' ? '' : path,
    // Hash the exact copied runtime content, not the source file's frontmatter.
    // The tuple makes the digest reproducible and independent of object order.
    contentSha256: bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([skill.name, skill.description, skill.instructions])))),
  });
}
