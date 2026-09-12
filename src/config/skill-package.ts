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
const AUXILIARY_EXT = /\.(md|mdx|txt|rst|yaml|yml|json|jsonc|toml|ini|cfg|csv|tsv|html?|css|xml|svg|png|jpe?g|gif|webp|ico|avif|pdf|woff2?|ttf|otf|mp3|wav|mp4|webm)$/i;

export function inspectSkillPackage(directory: string, entries: SkillPackageEntry[]): SkillPackageInspection {
  const result: SkillPackageInspection = {
    complete: true, scriptPaths: [], auxiliaryPaths: [], unknownPaths: [], warnings: [],
  };
  const prefix = directory ? `${directory}/` : '';
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix) || entry.type === 'tree') continue;
    const path = entry.path.slice(prefix.length);
    if (entry.type !== 'blob' || (entry.mode && !['100644', '100755'].includes(entry.mode))) {
      result.unknownPaths.push(path);
    } else if (path === 'SKILL.md' || AUXILIARY_EXT.test(path) ||
        /(?:^|\/)(LICENSE|NOTICE)(?:\.[\w-]+)?$/i.test(path) ||
        /(?:^|\/)\.(gitignore|gitattributes|gitkeep|editorconfig|npmignore|prettierignore)$/i.test(path)) {
      if (path !== 'SKILL.md') result.auxiliaryPaths.push(path);
      if (entry.mode === '100755') result.warnings.push(`File execution mode is not applied: ${path}.`);
    } else if (SCRIPT_EXT.test(path) || entry.mode === '100755' || /(?:^|\/)(Makefile|Dockerfile)$/i.test(path)) {
      result.scriptPaths.push(path);
    } else result.unknownPaths.push(path);
  }
  result.scriptPaths.sort();
  result.auxiliaryPaths.sort();
  result.unknownPaths.sort();
  if (result.auxiliaryPaths.length) result.warnings.push('Instructions that depend on omitted files may be incomplete.');
  return result;
}

export function describeSkillPaths(paths: string[]): string {
  return paths.slice(0, 6).join(', ') + (paths.length > 6 ? `, and ${paths.length - 6} more` : '');
}
