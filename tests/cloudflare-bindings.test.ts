import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

test('Cloudflare ambient bindings resolve without skipLibCheck', () => {
  const declaration = 'types/cloudflare-workers.d.ts';
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  assert.equal(config.error, undefined);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
  const program = ts.createProgram([declaration], { ...options, noEmit: true, skipLibCheck: false });
  const source = program.getSourceFile(declaration);
  assert.ok(source);
  // Check this shim itself, not the overlapping Node/Workers library globals.
  // Otherwise skipLibCheck can hide a removed export and leak an error-any type.
  assert.deepEqual(program.getSemanticDiagnostics(source).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
