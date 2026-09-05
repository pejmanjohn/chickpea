// Bounded, credential-free checks. Live Slack and real-model evaluation are
// deliberately separate so this command never needs a browser or consent.
export const REGRESSION_AREAS = Object.freeze({
  delivery: ['slack-admission', 'slack-thread-context', 'gateway-inbox', 'gateway-session-runner', 'flue-v2-runtime-regressions'],
  agents: ['management-policy', 'management-security-regression', 'management-agent-creation-welcome', 'management-agent-parity', 'slack-proposal-approval-readback', 'agent-authoring-guide'],
  routines: ['routine-schedule', 'routine-scheduler', 'routine-delivery', 'routine-workflow', 'routine-channel-destination'],
  connections: ['connection-accounts', 'managed-authorization-flow', 'api-connection-runtime', 'managed-connections'],
  memory: ['agent-memory', 'memory-runtime', 'memory-validation'],
  skills: ['skill-import', 'management-skill-import', 'connector-skills'],
  auth: ['slack-install-oauth', 'slack-oidc', 'auth-principal', 'admin-authorization'],
  admin: ['admin-page', 'agent-admin-routes', 'admin-authorization'],
  providers: ['provider-runtime-models', 'cloudflare-provider', 'runtime-model-route-evidence'],
  verification: ['verification-record', 'verification-regression', 'deploy-with-epilogue', 'local-worker-lane', 'live-contract-schema', 'live-contract-runner', 'oss-export'],
});

const rules = [
  [/^src\/slack\/(?:install-oauth|installation-credentials|credential-keyring|setup|gateway\/installation-authority)/, ['auth', 'delivery']],
  [/^src\/slack\//, ['delivery']],
  [/^src\/agents\//, ['agents', 'delivery']],
  [/^src\/management\//, ['agents', 'routines', 'connections', 'skills']],
  [/^src\/routines\//, ['routines']],
  [/^src\/connections\//, ['connections']],
  [/^src\/memory\//, ['memory']],
  [/^src\/(?:auth|identity)\//, ['auth']],
  [/^(?:src\/admin\/|assets\/admin-ui\/)/, ['admin']],
  [/^src\/(?:cloudflare-provider\.ts|model-compat\/|model-catalog\/)/, ['providers']],
  [/^(?:qa\/live\/|\.agents\/skills\/chickpea-live-verification\/|scripts\/(?:verify-regression\.mjs|verification-record\.mjs|live-test-resource-ledger\.mjs|deploy-with-epilogue\.mjs|chickpea-(?:environment|local-worker)\.mjs|lib\/(?:verification-(?:record|inputs|spec|repairs)|private-evidence|regression-plan|environment-[^/]+|local-worker-lane)\.mjs))/, ['verification']],
];

export function createRegressionPlan({ mode = 'changed', areas = [], files = [], testFiles = [] } = {}) {
  if (!['changed', 'regression', 'release'].includes(mode)) throw new Error('mode must be changed, regression, or release');
  for (const area of areas) {
    if (!Object.hasOwn(REGRESSION_AREAS, area)) throw new Error(`Unknown area: ${area}`);
  }
  const selected = new Set(areas);
  const directlyChangedTests = new Set();
  const unclassified = [];
  // This composition module owns setup/auth, connection callbacks, and Agent
  // configuration as well as Admin. A UI-only selection would miss regressions.
  const broadChanges = files.filter((file) => file === 'src/admin/routes.ts');
  for (const file of files) {
    const match = rules.find(([pattern]) => pattern.test(file));
    if (match) match[1].forEach((area) => selected.add(area));
    else if (/^tests\/(?:usage\/)?[^/]+\.test\.ts$/.test(file)) {
      if (testFiles.includes(file)) directlyChangedTests.add(file);
      else unclassified.push(file); // Deleting a test cannot produce an empty pass.
      for (const [area, names] of Object.entries(REGRESSION_AREAS)) {
        if (names.some((name) => file === `tests/${name}.test.ts`)) selected.add(area);
      }
    } else if (!/^(?:docs\/.*\.(?:md|txt)$|[^/]+\.(?:md|txt)$|LICENSE$|NOTICE$)/.test(file)) unclassified.push(file);
  }
  const noSelection = areas.length === 0 && files.length === 0;
  const fullTests = mode === 'release' || unclassified.length > 0 || broadChanges.length > 0;
  if (mode !== 'changed' || noSelection || fullTests) {
    Object.keys(REGRESSION_AREAS).forEach((area) => selected.add(area));
  }
  const requestedTests = [...new Set([
    ...[...selected].flatMap((area) => REGRESSION_AREAS[area].map((name) => `tests/${name}.test.ts`)),
    ...directlyChangedTests,
  ])].sort();
  const missing = requestedTests.filter((file) => !testFiles.includes(file));
  if (missing.length) throw new Error(`Regression inventory is stale: ${missing.join(', ')}`);
  const steps = [];
  const npm = (script) => steps.push({ kind: 'npm', script });
  const hasChecks = fullTests || requestedTests.length > 0;
  if (hasChecks) {
    npm('build');
    if (fullTests) npm('test');
    else {
      npm('typecheck');
      steps.push({ kind: 'tests', files: requestedTests });
    }
  }
  const broad = mode !== 'changed' || noSelection || fullTests;
  const includes = (...values) => values.some((area) => selected.has(area));
  if (broad || includes('delivery')) steps.push({ kind: 'node', file: 'scripts/verify-flue-offline-turn.mjs' });
  if (broad || includes('delivery', 'memory')) npm('verify:durability');
  if (broad || includes('providers', 'connections')) npm('verify:providers');
  if (broad || includes('agents', 'routines', 'skills')) npm('evaluate:agent-authoring');
  if (broad || includes('admin')) npm('verify:admin-ui');
  if (fullTests || includes('auth')) npm('verify:cf-smoke');
  if (mode === 'release') {
    npm('verify:lockfile-integrity');
    npm('verify:oss-export');
  }
  return {
    mode, areas: [...selected].sort(), fullTests, unclassified, broadChanges, steps,
    coverage: 'Deterministic and fake-service checks only. No real-model, Slack, OAuth, or deployed acceptance.',
  };
}
