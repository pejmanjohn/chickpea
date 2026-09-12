/** Classification of a bounded file inventory, not a guarantee about arbitrary code. */
export interface SkillPackageInspection {
  complete: boolean;
  scriptPaths: string[];
  auxiliaryPaths: string[];
  unknownPaths: string[];
  warnings: string[];
}

export interface SkillPackageEntry {
  path: string;
  type: string;
  mode?: string;
}

const SCRIPT_EXT = /\.(sh|py|pyc|js|mjs|cjs|jsx|ts|tsx|rb|bash|zsh|fish|ps1|psm1|bat|cmd|exe|dll|so|dylib|wasm|pl|php|lua|jar|class)$/i;
const AUXILIARY_EXT = /\.(md|mdx|txt|rst|yaml|yml|json|jsonc|toml|ini|cfg|csv|tsv|xml|svg|png|jpe?g|gif|webp|ico|avif|pdf|woff2?|ttf|otf|mp3|wav|mp4|webm)$/i;

export function inspectSkillPackage(directory: string, entries: SkillPackageEntry[]): SkillPackageInspection {
  const result: SkillPackageInspection = {
    complete: true, scriptPaths: [], auxiliaryPaths: [], unknownPaths: [], warnings: [],
  };
  const prefix = directory ? `${directory}/` : '';
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || entry.type === 'tree') continue;
    const path = entry.path.slice(prefix.length);
    // Inspect the document mode too: an executable SKILL.md is not ordinary metadata.
    if (entry.mode === '100755') result.scriptPaths.push(path);
    else if (entry.type !== 'blob' || (entry.mode && entry.mode !== '100644')) result.unknownPaths.push(path);
    else if (path === 'SKILL.md') continue;
    else if (SCRIPT_EXT.test(path)) result.scriptPaths.push(path);
    else if (AUXILIARY_EXT.test(path) || /(?:^|\/)(LICENSE|NOTICE)(?:\.[\w-]+)?$/i.test(path)) result.auxiliaryPaths.push(path);
    else result.unknownPaths.push(path);
  }
  result.scriptPaths.sort();
  result.auxiliaryPaths.sort();
  result.unknownPaths.sort();
  if (result.auxiliaryPaths.length) result.warnings.push('Supporting files are omitted; instructions that depend on them may be incomplete.');
  return result;
}

export function describeSkillPaths(paths: string[]): string {
  return paths.slice(0, 6).join(', ') + (paths.length > 6 ? `, and ${paths.length - 6} more` : '');
}
