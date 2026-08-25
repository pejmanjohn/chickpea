import { SLACK_STREAM_ANSWER_TOOL_NAME } from './presentation-intent.ts';

export type SlackStreamingPolicyExpectation =
  | 'clear_positive'
  | 'clear_negative'
  | 'ambiguous';

export interface SlackStreamingPolicyFixture {
  id: string;
  expectation: SlackStreamingPolicyExpectation;
  category: string;
  prompt: string;
}

export interface SlackStreamingPolicyFixtureSet {
  schemaVersion: 1;
  fixtures: SlackStreamingPolicyFixture[];
}

export interface SlackStreamingPolicyTrial {
  fixtureId: string;
  expectation: SlackStreamingPolicyExpectation;
  category: string;
  /** Whether the model called stream_answer. */
  declared: boolean;
  /** A declaration, when present, preceded all answer text. */
  declarationBeforeText: boolean;
  /** Exactly one no-argument stream_answer call was made. */
  declarationShapeValid: boolean;
  /** The final answer mentioned the hidden delivery mechanism or acknowledgement. */
  contaminationDetected: boolean;
  /** Model/provider-boundary proxy for when offered answer text is ready. */
  offeredProviderReadyMs: number;
  /** Time at which a valid stream_answer declaration completed. */
  declarationMs?: number;
  /** Model/provider-boundary proxy for when a paired terminal control is ready. */
  controlProviderReadyMs?: number;
}

export interface SlackStreamingToolCall {
  id: string;
  name: string;
  arguments?: unknown;
}

export interface SlackStreamingDeclarationAssessment {
  declared: boolean;
  declarationShapeValid: boolean;
  declarationId?: string;
}

export interface SlackStreamingPolicyLatencySummary {
  count: number;
  p50: number | null;
  p90: number | null;
}

export interface SlackStreamingPolicyEvaluation {
  schemaVersion: 1;
  evidenceScope: 'model_policy_and_provider_latency_proxy';
  slackVisibleLatencyVerified: false;
  launchReady: false;
  trialCount: number;
  thresholds: {
    positiveRecall: number;
    negativeAbstention: number;
  };
  positive: { total: number; selected: number; recall: number | null };
  negative: { total: number; abstained: number; abstentionRate: number | null };
  ambiguous: { total: number; selected: number; selectionRate: number | null };
  protocolViolations: number;
  contaminationCount: number;
  latencyMs: {
    declaration: SlackStreamingPolicyLatencySummary;
    offeredProviderReady: SlackStreamingPolicyLatencySummary;
    controlProviderReady: SlackStreamingPolicyLatencySummary;
  };
  failedFixtureIds: string[];
  policyPass: boolean;
  providerLatencyProxyPass: boolean;
  pass: boolean;
}

export const SLACK_STREAMING_POLICY_THRESHOLDS = {
  positiveRecall: 0.8,
  negativeAbstention: 0.9,
} as const;

/** Classify the declaration turn without attempting an invalid continuation. */
export function assessSlackStreamingDeclaration(
  calls: readonly SlackStreamingToolCall[],
): SlackStreamingDeclarationAssessment {
  const declarations = calls.filter((call) => call.name === SLACK_STREAM_ANSWER_TOOL_NAME);
  const declared = declarations.length > 0;
  const declaration = declarations[0];
  const argumentsValue = declaration?.arguments;
  const argumentsValid = argumentsValue === undefined ||
    (argumentsValue !== null && typeof argumentsValue === 'object' &&
      !Array.isArray(argumentsValue) && Object.keys(argumentsValue).length === 0);
  const declarationShapeValid = declarations.length === 1 && calls.length === 1 && argumentsValid;
  return {
    declared,
    declarationShapeValid,
    ...(declarationShapeValid && declaration ? { declarationId: declaration.id } : {}),
  };
}

export function parseSlackStreamingPolicyFixtureSet(
  value: unknown,
): SlackStreamingPolicyFixtureSet {
  if (!value || typeof value !== 'object') throw new Error('Fixture set must be an object.');
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.fixtures)) {
    throw new Error('Fixture set must use schemaVersion 1 and contain fixtures.');
  }
  const ids = new Set<string>();
  const fixtures = input.fixtures.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`Fixture ${index + 1} must be an object.`);
    }
    const fixture = candidate as Record<string, unknown>;
    if (typeof fixture.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,79}$/.test(fixture.id)) {
      throw new Error(`Fixture ${index + 1} has an invalid id.`);
    }
    if (ids.has(fixture.id)) throw new Error(`Fixture id ${fixture.id} is duplicated.`);
    ids.add(fixture.id);
    if (!isExpectation(fixture.expectation)) {
      throw new Error(`Fixture ${fixture.id} has an invalid expectation.`);
    }
    if (typeof fixture.category !== 'string' ||
        !/^[a-z][a-z0-9_]{2,49}$/.test(fixture.category)) {
      throw new Error(`Fixture ${fixture.id} has an invalid category.`);
    }
    if (typeof fixture.prompt !== 'string' ||
        fixture.prompt.trim() !== fixture.prompt ||
        fixture.prompt.length < 10 || fixture.prompt.length > 4_000) {
      throw new Error(`Fixture ${fixture.id} has an invalid prompt.`);
    }
    return {
      id: fixture.id,
      expectation: fixture.expectation,
      category: fixture.category,
      prompt: fixture.prompt,
    };
  });
  for (const expectation of ['clear_positive', 'clear_negative', 'ambiguous'] as const) {
    if (!fixtures.some((fixture) => fixture.expectation === expectation)) {
      throw new Error(`Fixture set is missing ${expectation} cases.`);
    }
  }
  return { schemaVersion: 1, fixtures };
}

/**
 * Score content-free trial facts. Ambiguous cases are reported but deliberately
 * excluded from launch thresholds so they can reveal the model's boundary
 * without teaching a brittle application-side classifier.
 */
export function evaluateSlackStreamingPolicy(
  trials: readonly SlackStreamingPolicyTrial[],
): SlackStreamingPolicyEvaluation {
  for (const trial of trials) validateTrial(trial);
  const positive = trials.filter((trial) => trial.expectation === 'clear_positive');
  const negative = trials.filter((trial) => trial.expectation === 'clear_negative');
  const ambiguous = trials.filter((trial) => trial.expectation === 'ambiguous');
  const validSelection = (trial: SlackStreamingPolicyTrial) =>
    trial.declared && trial.declarationBeforeText && trial.declarationShapeValid;
  const positiveSelected = positive.filter(validSelection).length;
  const negativeAbstained = negative.filter((trial) => !trial.declared).length;
  const ambiguousSelected = ambiguous.filter(validSelection).length;
  const protocolViolations = trials.filter((trial) =>
    trial.declared && (!trial.declarationBeforeText || !trial.declarationShapeValid)
  ).length;
  const contaminationCount = trials.filter((trial) => trial.contaminationDetected).length;
  const pairedPositive = positive.filter((trial) =>
    validSelection(trial) && trial.controlProviderReadyMs !== undefined
  );
  const declaration = summarize(pairedPositive.flatMap((trial) =>
    trial.declarationMs === undefined ? [] : [trial.declarationMs]
  ));
  const offeredProviderReady = summarize(
    pairedPositive.map((trial) => trial.offeredProviderReadyMs),
  );
  const controlProviderReady = summarize(
    pairedPositive.map((trial) => trial.controlProviderReadyMs!),
  );
  const positiveRecall = rate(positiveSelected, positive.length);
  const negativeAbstention = rate(negativeAbstained, negative.length);
  const providerLatencyProxyPass = offeredProviderReady.count > 0 &&
    offeredProviderReady.p50! < controlProviderReady.p50! &&
    offeredProviderReady.p90! < controlProviderReady.p90!;
  const failedFixtureIds = [...new Set(trials.flatMap((trial) => {
    const failedExpectation = trial.expectation === 'clear_positive'
      ? !validSelection(trial)
      : trial.expectation === 'clear_negative' && trial.declared;
    const failedProtocol = trial.declared &&
      (!trial.declarationBeforeText || !trial.declarationShapeValid);
    return failedExpectation || failedProtocol || trial.contaminationDetected
      ? [trial.fixtureId]
      : [];
  }))].sort();
  const policyPass = positiveRecall !== null &&
    positiveRecall >= SLACK_STREAMING_POLICY_THRESHOLDS.positiveRecall &&
    negativeAbstention !== null &&
    negativeAbstention >= SLACK_STREAMING_POLICY_THRESHOLDS.negativeAbstention &&
    protocolViolations === 0 && contaminationCount === 0;
  return {
    schemaVersion: 1,
    evidenceScope: 'model_policy_and_provider_latency_proxy',
    slackVisibleLatencyVerified: false,
    launchReady: false,
    trialCount: trials.length,
    thresholds: { ...SLACK_STREAMING_POLICY_THRESHOLDS },
    positive: {
      total: positive.length,
      selected: positiveSelected,
      recall: positiveRecall,
    },
    negative: {
      total: negative.length,
      abstained: negativeAbstained,
      abstentionRate: negativeAbstention,
    },
    ambiguous: {
      total: ambiguous.length,
      selected: ambiguousSelected,
      selectionRate: rate(ambiguousSelected, ambiguous.length),
    },
    protocolViolations,
    contaminationCount,
    latencyMs: { declaration, offeredProviderReady, controlProviderReady },
    failedFixtureIds,
    policyPass,
    providerLatencyProxyPass,
    pass: policyPass && providerLatencyProxyPass,
  };
}

function validateTrial(trial: SlackStreamingPolicyTrial): void {
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(trial.fixtureId) ||
      !isExpectation(trial.expectation) ||
      !/^[a-z][a-z0-9_]{2,49}$/.test(trial.category)) {
    throw new Error('Streaming policy trial identity is invalid.');
  }
  for (const value of [
    trial.offeredProviderReadyMs,
    trial.declarationMs,
    trial.controlProviderReadyMs,
  ]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Streaming policy trial ${trial.fixtureId} has invalid timing.`);
    }
  }
  if (!trial.declared && trial.declarationMs !== undefined) {
    throw new Error(`Streaming policy trial ${trial.fixtureId} timed a missing declaration.`);
  }
}

function isExpectation(value: unknown): value is SlackStreamingPolicyExpectation {
  return value === 'clear_positive' || value === 'clear_negative' || value === 'ambiguous';
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function summarize(values: readonly number[]): SlackStreamingPolicyLatencySummary {
  if (values.length === 0) return { count: 0, p50: null, p90: null };
  const ordered = [...values].sort((left, right) => left - right);
  return {
    count: ordered.length,
    p50: percentile(ordered, 0.5),
    p90: percentile(ordered, 0.9),
  };
}

function percentile(ordered: readonly number[], quantile: number): number {
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)]!;
}
