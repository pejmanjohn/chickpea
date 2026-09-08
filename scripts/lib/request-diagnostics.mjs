import { createHash } from 'node:crypto';

export const DIAGNOSTIC_SCHEMA = 'chickpea-request-diagnostics/v1';
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:/@-]{1,160}$/.test(value)
  && !/^(?:sk-|xox[bpars]-|gh[pousr]_)/.test(value) ? value : null;
const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const opaque = (prefix, value) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;

export function resolveDiagnosticRequest(input) {
  const { workspaceId, workerName, accountId, adminOrigin } = input;
  if (!/^T[A-Z0-9_]{2,63}$/.test(workspaceId ?? '')) throw new Error('A registered Slack workspace ID is required.');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(workerName ?? '')) throw new Error('An exact Worker name is required.');
  const local = input.local === true;
  if (!local && !/^[a-f0-9]{32}$/.test(accountId ?? '')) throw new Error('An explicitly resolved Cloudflare account ID is required.');
  const origin = new URL(adminOrigin);
  const protocolAllowed = local
    ? origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    : origin.protocol === 'https:';
  if (!protocolAllowed || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Use a credential-free HTTPS Admin origin, or a loopback HTTP origin with --local.');
  }
  let runId = input.runId;
  let messageMs;
  if (input.slackUrl) {
    const slack = new URL(input.slackUrl);
    const match = slack.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})$/);
    if (slack.protocol !== 'https:' || !/^[a-z0-9-]+\.slack\.com$/.test(slack.hostname) || !match || slack.username || slack.password || slack.port) {
      throw new Error('Use the canonical Slack message permalink.');
    }
    const derived = opaque('run', `slack:${workspaceId}:${match[1]}:${match[2]}.${match[3]}`);
    if (runId && runId !== derived) throw new Error('Run ID and Slack message disagree.');
    runId = derived;
    messageMs = Number(match[2]) * 1000 + Math.floor(Number(match[3]) / 1000);
  }
  if (!/^[a-z][a-z0-9_-]{7,127}$/.test(runId ?? '')) throw new Error('Provide a Run ID or Slack permalink.');
  const parseUtc = (value) => typeof value === 'string' && /Z$/.test(value) ? Date.parse(value) : NaN;
  const from = input.from ? parseUtc(input.from) : messageMs - 60_000;
  const to = input.to ? parseUtc(input.to) : messageMs + 16 * 60_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 30 * 60_000) {
    throw new Error('Provide a UTC window ending in Z, at most 30 minutes. Run-ID-only lookups need --from and --to.');
  }
  if (input.traceId && !/^[a-f0-9]{32}$/.test(input.traceId)) throw new Error('Invalid trace ID.');
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA,
    runtime: local ? 'local' : 'cloudflare',
    target: token(input.target), workspaceId, accountId: local ? null : accountId, workerName, runId,
    accountRef: opaque('account', `slack:${workspaceId}`),
    adminUrl: `${origin.origin}/admin/api/sessions/${runId}?diagnostics=1`,
    timeframe: { from, to },
    suppliedTraceId: input.traceId ?? null,
    ...(local ? { explorerUrl: `${origin.origin}/cdn-cgi/local/explorer/api/local/observability/query` } : {}),
  };
}

/** Project an authenticated Sessions response; never retain its optional bodies. */
export function projectDiagnosticSession(value, request) {
  if (value?.error === 'session_not_found') return null;
  if (value?.session?.runId !== request.runId) throw new Error('Session does not match the requested Run.');
  const accountRef = value.accountRef ?? value.binding?.externalAccountId;
  if (accountRef !== request.accountRef) throw new Error('Session belongs to another Slack workspace.');
  if (!Array.isArray(value.executions) || !Array.isArray(value.timeline)) throw new Error('Session evidence is malformed.');
  const pick = (source, fields) => Object.fromEntries(fields.map((key) => [key, token(source?.[key])]));
  return {
    runId: request.runId,
    ...pick(value.session, ['status', 'terminalDisposition', 'deliveryStatus', 'safeFailureCode', 'contentAccess']),
    createdAt: number(value.session.createdAt), settledAt: number(value.session.settledAt),
    deliveryFinalizedAt: number(value.delivery?.finalizedAt ?? value.session.deliveryFinalizedAt),
    executions: (value.executions ?? []).slice(0, 100).map((execution) => ({
      ...pick(execution, ['id', 'canonicalModel', 'modelInvocationStatus', 'outcome', 'safeFailureCode']),
      flueInstanceRef: /^flueinstance_[a-f0-9]{40}$/.test(execution.flueInstanceRef ?? '') ? execution.flueInstanceRef : null,
      flueSubmissionRef: /^fluesubmission_[a-f0-9]{40}$/.test(execution.flueSubmissionRef ?? '') ? execution.flueSubmissionRef : null,
      startedAt: number(execution.startedAt), finishedAt: number(execution.finishedAt),
    })),
    timeline: (value.timeline ?? []).slice(0, 500).map((event) => ({
      ...pick(event, ['eventId', 'eventType', 'outcome', 'reasonCode']),
      createdAt: number(event.createdAt),
    })),
    limitsReached: value.limits?.executions === true || value.limits?.timeline === true ||
      value.executions?.length >= 100 || value.timeline?.length >= 500,
  };
}

/** Self-contained for Cloudflare API MCP execute. No credentials or runtime
 * contents are embedded in the generated script. requestApi is cloudflare.request.
 */
export async function collectCloudflareDiagnostics(input, requestApi) {
  const { request, session } = input;
  const base = `/accounts/${request.accountId}/workers`;
  const gaps = [];
  const queries = [];
  const safeToken = (v) => typeof v === 'string' && /^[A-Za-z0-9_.:/@-]{1,160}$/.test(v)
    && !/^(?:sk-|xox[bpars]-|gh[pousr]_)/.test(v) ? v : null;
  const safeNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const field = (s, key) => s?.[key] ?? key.split('.').reduce((v, k) => v?.[k], s);
  const traceOf = (e) => e.$metadata?.traceId ?? e.$workers?.traceId ?? e.source?.traceId;
  const validTrace = (v) => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
  const filter = (key, value) => ({ key, type: 'string', operation: 'eq', value });
  async function call(options) {
    try {
      return await requestApi(options);
    } catch {
      return { success: false, status: 0 };
    }
  }
  async function query(label, filters, maxPages = 3) {
    const all = [];
    const cursors = new Set();
    let offset;
    for (let page = 0; page < maxPages; page++) {
      const r = await call({ method: 'POST', path: `${base}/observability/telemetry/query`, body: {
        queryId: 'chickpea-request-diagnostics', dry: true, view: 'events', limit: 100,
        timeframe: request.timeframe, parameters: { filters, filterCombination: 'and' },
        ...(offset ? { offset, offsetDirection: 'next' } : {}),
      } });
      queries.push({ label, page, status: r.status, state: r.result?.run?.status ?? null,
        abrLevel: r.result?.statistics?.abr_level ?? null });
      if (r.result?.statistics?.abr_level > 1) gaps.push(`${label}_adaptive_sampling`);
      if (!r.success || r.result?.run?.status !== 'COMPLETED' || !Array.isArray(r.result?.events?.events)) {
        gaps.push(`${label}_query_unavailable`);
        break;
      }
      const events = r.result.events.events;
      all.push(...events);
      if (events.length < 100) break;
      offset = events.at(-1)?.$metadata?.id;
      if (!offset || cursors.has(offset) || page === maxPages - 1) {
        gaps.push(`${label}_page_limit`);
        break;
      }
      cursors.add(offset);
    }
    return all;
  }
  // These are current settings/traffic, never assumed to be the incident version.
  const settings = await call({ method: 'GET', path: `${base}/scripts/${request.workerName}/settings` });
  const deployments = await call({ method: 'GET', path: `${base}/scripts/${request.workerName}/deployments` });
  if (!settings.success) gaps.push('settings_unavailable');
  if (!deployments.success) gaps.push('deployments_unavailable');
  const current = [...(Array.isArray(deployments.result?.deployments) ? deployments.result.deployments : [])]
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  const observability = settings.result?.observability;
  const collection = {
    logsEnabled: observability?.logs?.enabled ?? observability?.enabled ?? null,
    logsPersisted: observability?.logs?.persist ?? null,
    logsSampling: observability?.logs?.head_sampling_rate ?? observability?.head_sampling_rate ?? null,
    tracesEnabled: observability?.traces?.enabled ?? null,
    tracesPersisted: observability?.traces?.persist ?? null,
    tracesSampling: observability?.traces?.head_sampling_rate ?? null,
  };
  if (Object.values(collection).some((v) => v === false) ||
    [collection.logsSampling, collection.tracesSampling].some((v) => typeof v === 'number' && v < 1)) gaps.push('collection_incomplete');
  const references = [...new Set((session?.executions ?? []).map((e) => e.flueSubmissionRef).filter(Boolean))];
  const traces = new Set();
  let correlation = 'unavailable';
  if (request.suppliedTraceId) {
    traces.add(request.suppliedTraceId);
    correlation = 'operator_supplied_trace';
  } else if (references.length) {
    // Discover the application field before filtering. Older deployments may
    // have no bridge event; an empty result never becomes proof of no execution.
    const keys = await call({ method: 'POST', path: `${base}/observability/telemetry/keys`, body: {
      ...request.timeframe, limit: 10, filters: [filter('$metadata.service', request.workerName)],
      keyNeedle: { value: '^flueSubmissionRef$', isRegex: true, matchCase: true },
    } });
    if (keys.success && Array.isArray(keys.result) && keys.result.some((k) => k.key === 'flueSubmissionRef' && k.type === 'string')) {
      for (const ref of references.slice(0, 8)) {
        const seeds = await query('correlation', [filter('$metadata.service', request.workerName), filter('flueSubmissionRef', ref)], 1);
        for (const e of seeds) {
          if (e.source?.event === 'run.correlation' && e.source?.flueSubmissionRef === ref && validTrace(traceOf(e))) traces.add(traceOf(e));
        }
      }
      if (traces.size) correlation = 'ledger_submission';
      if (references.length > 8) gaps.push('execution_limit');
    } else gaps.push('correlation_field_unavailable');
  }
  if (!traces.size) gaps.push('no_correlated_trace');
  if (!session) gaps.push('ledger_unavailable');
  if (session?.limitsReached) gaps.push('ledger_page_limit');
  if (session?.settledAt > request.timeframe.to) gaps.push('window_ends_before_settlement');
  const timeline = [];
  const seen = new Set();
  for (const traceId of [...traces].slice(0, 8)) {
    // Exact trace membership includes attributable downstream Workers, which a
    // Worker-only filter would hide. Never broaden to uncorrelated account logs.
    for (const e of await query('trace', [filter('$metadata.traceId', traceId)])) {
      if (traceOf(e) !== traceId || (e.$metadata?.id && seen.has(e.$metadata.id))) continue;
      if (e.$metadata?.id) seen.add(e.$metadata.id);
      let source = typeof e.source === 'string' ? { message: e.source } : e.source ?? {};
      const legacy = source.message?.match?.(/^\[chickpea:(management|routines)\] (\{.*\})$/s);
      if (legacy) { try { source = { ...JSON.parse(legacy[2]), component: legacy[1] }; } catch {} }
      if (e.$workers?.truncated) gaps.push('truncated_event');
      const operation = safeToken(field(source, 'gen_ai.operation.name'));
      const event = safeToken(source.event);
      if (!operation && !event && e.$metadata?.type !== 'cf-worker-event') continue;
      timeline.push({
        at: safeNumber(e.timestamp), source: 'cloudflare', traceId,
        requestId: safeToken(e.$metadata?.requestId ?? e.$workers?.requestId),
        spanId: safeToken(e.$metadata?.spanId ?? source.spanId),
        parentSpanId: safeToken(e.$metadata?.parentSpanId ?? source.parentSpanId),
        worker: safeToken(e.$metadata?.service),
        version: safeToken(e.$workers?.scriptVersion?.id ?? field(source, 'cloudflare.script_version.id')),
        event: event ?? operation ?? 'invocation',
        component: safeToken(source.component),
        tool: safeToken(source.tool ?? field(source, 'gen_ai.tool.name')),
        model: safeToken(field(source, 'gen_ai.request.model')),
        outcome: safeToken(source.outcome ?? e.$workers?.outcome),
        reason: safeToken(source.reason ?? source.code),
        errorReported: Boolean(field(source, 'error.type') ?? source.errorType ?? e.$metadata?.error),
        finishReason: safeToken(field(source, 'flue.response.finish_reason')),
        durationMs: safeNumber(source.durationMS ?? source.durationMs ?? e.$metadata?.duration ?? e.$workers?.wallTimeMs),
        inputTokens: safeNumber(field(source, 'gen_ai.usage.input_tokens')),
        outputTokens: safeNumber(field(source, 'gen_ai.usage.output_tokens')),
      });
    }
  }
  if (traces.size > 8) gaps.push('trace_limit');
  if (traces.size && !timeline.length) gaps.push('no_retained_trace_events');
  if (timeline.length && !timeline.some((e) => e.worker === request.workerName)) gaps.push('target_worker_not_in_trace');
  for (const e of session?.timeline ?? []) timeline.push({
    at: e.createdAt, source: 'ledger', event: e.eventType, outcome: e.outcome, reason: e.reasonCode,
  });
  timeline.sort((a, b) => a.at - b.at);
  return {
    schemaVersion: 'chickpea-diagnostic-report/v1',
    runId: request.runId, worker: request.workerName, timeframe: request.timeframe,
    collectedAt: new Date().toISOString(), correlation, session, collection,
    currentDeployment: current ? { createdAt: safeToken(current.created_on),
      versions: (Array.isArray(current.versions) ? current.versions : []).slice(0, 20)
        .map((v) => ({ versionId: safeToken(v.version_id), percentage: safeNumber(v.percentage) })) } : null,
    queries, timeline, gaps: [...new Set(gaps)],
    conclusions: 'Diagnostic evidence only. Missing or sampled logs do not prove an action never happened. Verify saved state and Slack/provider outcomes separately.',
  };
}

export function cloudflareDiagnosticScript(request, session) {
  return `async () => {\n  const input = ${JSON.stringify({ request, session })};\n  return (${collectCloudflareDiagnostics.toString()})(input, (options) => cloudflare.request(options));\n}\n`;
}

/** The Local Explorer query uses its documented read-only SQL API. Console
 * arguments are JSON arrays; only the exact opaque bridge ref selects traces.
 * Neither raw log messages nor full span attributes are returned.
 */
export function localDiagnosticQuery(request, session) {
  const refs = [...new Set((session?.executions ?? []).map((e) => e.flueSubmissionRef).filter(Boolean))].slice(0, 8);
  const traceSelector = request.suppliedTraceId ? 'SELECT ? AS trace_id' : `
    SELECT DISTINCT trace_id FROM logs
    WHERE ts_ms BETWEEN ? AND ? AND json_valid(message)
      AND json_extract(message, '$[0].event') = 'run.correlation'
      AND json_extract(message, '$[0].flueSubmissionRef') IN (${refs.map(() => '?').join(',') || 'NULL'})
    LIMIT 8`;
  const params = request.suppliedTraceId ? [request.suppliedTraceId] : [request.timeframe.from, request.timeframe.to, ...refs];
  return {
    sql: `WITH matched AS (${traceSelector})
      SELECT start_ms AS at, trace_id AS traceId, span_id AS spanId, parent_id AS parentSpanId,
        service AS worker, 'span' AS source,
        COALESCE(json_extract(json(attributes), '$."gen_ai.operation.name"'), 'invocation') AS event,
        json_extract(json(attributes), '$."gen_ai.tool.name"') AS tool,
        json_extract(json(attributes), '$."gen_ai.request.model"') AS model,
        outcome, error IS NOT NULL AS errorReported, duration_ms AS durationMs
      FROM spans WHERE trace_id IN (SELECT trace_id FROM matched) AND start_ms BETWEEN ? AND ?
      UNION ALL
      SELECT ts_ms, trace_id, span_id, NULL, NULL, 'log',
        json_extract(message, '$[0].event'), json_extract(message, '$[0].tool'), NULL,
        json_extract(message, '$[0].outcome'), json_extract(message, '$[0].errorType') IS NOT NULL,
        json_extract(message, '$[0].durationMs')
      FROM logs WHERE trace_id IN (SELECT trace_id FROM matched) AND ts_ms BETWEEN ? AND ?
        AND json_valid(message) AND json_extract(message, '$[0].event') IS NOT NULL
      ORDER BY at LIMIT 300`,
    params: [...params, request.timeframe.from, request.timeframe.to, request.timeframe.from, request.timeframe.to],
  };
}
