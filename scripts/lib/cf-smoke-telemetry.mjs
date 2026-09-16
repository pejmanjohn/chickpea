const CLOUDFLARE_SMOKE_TELEMETRY_BINDINGS = Object.freeze({
  DO_NOT_TRACK: '1',
  CHICKPEA_DISABLE_TELEMETRY: '1',
  CHICKPEA_TELEMETRY_ENVIRONMENT: 'test',
});

/**
 * Keep disposable workerd installs out of product analytics even when the
 * production config they are copied from explicitly opts in.
 */
export function withCloudflareSmokeTelemetryBindings(vars = {}) {
  return { ...vars, ...CLOUDFLARE_SMOKE_TELEMETRY_BINDINGS };
}

/** Wrangler resolves `.dev.vars` inside workerd, independently of host env. */
export function cloudflareSmokeTelemetryDevVars() {
  return Object.entries(CLOUDFLARE_SMOKE_TELEMETRY_BINDINGS)
    .map(([name, value]) => `${name}=${value}`);
}
