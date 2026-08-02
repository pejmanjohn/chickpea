const DRAIN_REQUEST_TIMEOUT_MS = 15_000;
const DRAIN_CATEGORY_KEYS = [
  'pendingLegacyTurnJobs',
  'pendingLedgerTurnJobs',
  'pendingSlackInteractionCleanups',
  'recoveryRequiredTurnJobs',
  'executingRuns',
  'admittingOrRunningRoutineOccurrences',
];

export async function runDrainCheck({ baseUrl, adminToken, fetchImpl = fetch }) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('CF_SMOKE_BASE_URL is required for --check-drain');
  }
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    throw new Error('TAG_ADMIN_TOKEN is required for --check-drain');
  }
  const endpoint = new URL('/admin/api/runtime/drain', baseUrl);
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('CF_SMOKE_BASE_URL must use http or https');
  }
  const response = await fetchImpl(endpoint, {
    cache: 'no-store',
    headers: { authorization: `Bearer ${adminToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(DRAIN_REQUEST_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`runtime drain request failed (HTTP ${response.status})`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('invalid runtime drain response');
  }
  const categories = body?.categories;
  const validCategories = categories && typeof categories === 'object' &&
    DRAIN_CATEGORY_KEYS.every((key) =>
      Number.isSafeInteger(categories[key]) && categories[key] >= 0
    );
  if (typeof body?.drained !== 'boolean' || !validCategories) {
    throw new Error('invalid runtime drain response');
  }
  const nonzero = DRAIN_CATEGORY_KEYS.filter((key) => categories[key] !== 0);
  if (body.drained !== (nonzero.length === 0)) {
    throw new Error('invalid runtime drain response');
  }
  if (nonzero.length > 0) {
    throw new Error(
      `deployment is not drained (${nonzero.map((key) => `${key}=${categories[key]}`).join(', ')})`,
    );
  }
  return body;
}
