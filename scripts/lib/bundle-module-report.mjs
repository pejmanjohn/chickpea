import path from 'node:path';

/**
 * Build-only provenance for size analysis and contract tests: every module in
 * the Worker's chunks, with its rendered length and the chunk that holds it.
 * Written beside the Worker; never imported by it and never a public asset.
 */
export function bundleModuleReport(fileName = 'bundle-modules.json') {
  return {
    name: `chickpea-bundle-module-report:${fileName}`,
    generateBundle(_options, bundle) {
      if (this.environment.name === 'client') return;
      const root = this.environment.config.root;
      const modules = Object.values(bundle).flatMap((output) => output.type === 'chunk'
        ? Object.entries(output.modules).map(([id, module]) => ({
          id: path.relative(root, id),
          renderedLength: module.renderedLength,
          chunk: output.fileName,
        }))
        : []);
      this.emitFile({ type: 'asset', fileName, source: JSON.stringify(modules) });
    },
  };
}
