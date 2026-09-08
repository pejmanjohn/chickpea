import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { createDeploymentInspector } from '../scripts/lib/inspect-deployment.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { validateTarget, validateInstallation, assertCompatibleRelease, overlayInstallation } from '../scripts/lib/upgrade-installation.mjs';

function fixture() {
  return {
    exists: true, fingerprint: 'old:100', versions: [{ version_id: 'old', percentage: 100 }],
    secretNames: ['CHICKPEA_AUTH_SECRET', 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID', 'CHICKPEA_CREDENTIAL_KEY_V1', 'OPENAI_API_KEY'],
    bindings: [
      ...['CHICKPEA_AUTH_SECRET', 'CHICKPEA_CREDENTIAL_KEY_CURRENT_ID', 'CHICKPEA_CREDENTIAL_KEY_V1', 'OPENAI_API_KEY'].map((name) => ({ name, type: 'secret_text' })),
      { name: 'AUTH_DB', type: 'd1', id: 'db-1' },
      { name: 'TAG_STATE', type: 'durable_object_namespace', namespace_id: 'ns-1', class_name: 'TagStateStore' },
      { name: 'AI', type: 'ai' }, { name: 'ASSETS', type: 'assets' }, { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
      ...Object.entries({ CHICKPEA_APP_VERSION: '0.1.0', CHICKPEA_SOURCE_COMMIT: 'a'.repeat(40), CHICKPEA_SETUP_CAPABILITY_DIGEST: 'a'.repeat(43), CHICKPEA_SETUP_CAPABILITY_ISSUED_AT: '1780000000000', DO_NOT_TRACK: '1' }).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    ],
  };
}
test('guided upgrades reject Sandbox profiles and malformed readiness origins', () => {
  const target = { account: 'a'.repeat(32), worker: 'customer', profile: 'core', url: 'https://customer.example/' };
  assert.equal(validateTarget(target).url, 'https://customer.example');
  assert.throws(() => validateTarget({ ...target, profile: 'sandbox' }), /Sandbox container images/);
  for (const url of ['http://customer.example', 'https://user:password@customer.example', 'https://customer.example/admin', 'https://customer.example/?token=x']) {
    assert.throws(() => validateTarget({ ...target, url }), /existing public HTTPS/);
  }
});
test('inspection performs only reads and returns the serving inventory', () => {
  const calls: string[][] = [];
  const inspector = createDeploymentInspector((args: string[]) => {
    calls.push(args);
    if (args[0] === 'secret') return { status: 0, stdout: JSON.stringify([{ name: 'CHICKPEA_AUTH_SECRET' }]) };
    if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: [{ version_id: 'old', percentage: 100 }] }) };
    return { status: 0, stdout: JSON.stringify({ resources: { bindings: fixture().bindings } }) };
  });
  assert.equal(inspector.inspect().fingerprint, 'old:100');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['secret', 'list'], ['deployments', 'status'], ['versions', 'view']]);
});
test('serving secret authority survives a transient empty script-wide list after upload', () => {
  const inspector = createDeploymentInspector((args: string[]) => {
    if (args[0] === 'secret') return { status: 0, stdout: '[]' };
    if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: fixture().versions }) };
    return { status: 0, stdout: JSON.stringify({ resources: { bindings: fixture().bindings } }) };
  });
  const installed = validateInstallation(inspector.inspect());
  assert.deepEqual(installed.secretNames, fixture().secretNames.sort());
  assert.equal(installed.workerVersion, 'old');
});
test('script-wide secret names cannot substitute for missing serving-version authority', () => {
  const inspector = createDeploymentInspector((args: string[]) => {
    if (args[0] === 'secret') return { status: 0, stdout: JSON.stringify(fixture().secretNames.map((name) => ({ name }))) };
    if (args[0] === 'deployments') return { status: 0, stdout: JSON.stringify({ versions: fixture().versions }) };
    return { status: 0, stdout: JSON.stringify({ resources: { bindings: fixture().bindings.filter((binding) => binding.type !== 'secret_text') } }) };
  });
  assert.throws(() => validateInstallation(inspector.inspect()), /Permanent auth or credential-encryption secrets are missing/);
});
test('installation preserves supported vars and resources without copying secrets', () => {
  const installation = validateInstallation(fixture());
  const config = { name: 'custom', vars: { CHICKPEA_APP_VERSION: '0.1.1', CHICKPEA_SOURCE_COMMIT: 'b'.repeat(40) }, d1_databases: [{ binding: 'AUTH_DB', database_name: 'auth', database_id: '' }], durable_objects: { bindings: [{ name: 'TAG_STATE', class_name: 'TagStateStore' }] }, ai: { binding: 'AI' }, assets: { binding: 'ASSETS' }, version_metadata: { binding: 'CF_VERSION_METADATA' } };
  const overlaid = overlayInstallation(config, installation, { worker: 'custom', profile: 'core' });
  assert.equal(overlaid.d1_databases[0].database_id, 'db-1');
  assert.equal(overlaid.vars.DO_NOT_TRACK, '1');
  assert.equal(overlaid.vars.CHICKPEA_APP_VERSION, '0.1.1');
  assert.equal(JSON.stringify(overlaid).includes('OPENAI_API_KEY'), false);
  for (const name of ['NEW_RELEASE_SETTING', 'SLACK_TAG_MODEL']) {
    assert.throws(() => overlayInstallation({ ...config, vars: { ...config.vars, [name]: 'new' } }, installation, { worker: 'custom', profile: 'core' }), /new Worker variable/);
  }
  assert.throws(() => overlayInstallation({ ...config, kv_namespaces: [{ binding: 'NEW_CACHE', id: 'new' }] }, installation, { worker: 'custom', profile: 'core' }), /unsupported resource/);
});
test('ambiguous identity, unknown configuration and missing authority are refused', () => {
  for (const change of [
    (value: any) => { value.versions.push({ version_id: 'other', percentage: 10 }); },
    (value: any) => { value.secretNames = []; },
    (value: any) => { value.bindings.push({ name: 'UNKNOWN', type: 'plain_text', text: 'private' }); },
    (value: any) => { value.bindings.push({ name: 'OPENAI_API_KEY', type: 'plain_text', text: 'private' }); },
    (value: any) => { value.bindings.push({ name: 'CACHE', type: 'kv_namespace', namespace_id: 'new' }); },
    (value: any) => { value.bindings = value.bindings.filter((binding: any) => binding.name !== 'AUTH_DB'); },
  ]) {
    const value = fixture(); change(value); assert.throws(() => validateInstallation(value));
  }
});
test('equal migration digests alone do not authorize a transition', () => {
  const before = { version: '0.1.0', storageGeneration: 1, migrations: { d1: 'a' }, recovery: 'previous-code-only' };
  const after = { ...before, version: '0.1.1', supportedOrigins: [] };
  assert.throws(() => assertCompatibleRelease(before, after), /supported/);
  after.supportedOrigins = ['0.1.0'] as never[];
  assert.doesNotThrow(() => assertCompatibleRelease(before, after));
  assert.throws(() => assertCompatibleRelease(before, { ...after, migrations: { d1: 'b' } }), /migration/);
});
