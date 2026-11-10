import type { PlatformEnv } from '../config/state-backend.ts';
import type { AgentModelAttribution } from '../config/types.ts';
import { usageInstallationId } from './model-requests.ts';
import type { ChickpeaResponseMetadata } from './response-metadata.ts';
import { estimateForRuntime, modelPolicyUsage, splitModelSpecifier } from './runtime-recorder.ts';
import type {
  AdmitUsageOperationInput,
  RecordUsageTerminalInput,
  UsageOperation,
  UsageUnknownReason,
} from './types.ts';

/** What a test run's usage operation is admitted with: the caller's direct message, never a channel. */
export interface TestRunUsageAdmission {
  testRunId: string;
  startedAt: number;
  workspaceId: string;
  agentId: string;
  agentLabel: string;
  /** The caller, whose direct message the run stands for. */
  requesterMembershipId: string;
  requestedModel: string | null;
  modelAttribution?: AgentModelAttribution;
  credentialRefId: string | null;
  credentialVersion: number | null;
  platformEnv?: PlatformEnv;
  processEnv?: NodeJS.ProcessEnv;
}

type TestRunUsageOperation = Pick<
  UsageOperation,
  'operationId' | 'requestedProvider' | 'requestedModel' | 'credentialRefId' | 'credentialVersion'
>;

/**
 * A test run's usage, as a direct message's: kind `test_turn`, the run as
 * its source, the caller as requester, no channel, and its charges under the
 * Flue submission the run's model access bound. The state store writes the
 * admission and the terminal in its own transactions, so this only builds
 * them; a terminal is built from the stored operation, after any restart.
 */
export class TestRunUsageRecorder {
  static operationId(testRunId: string): string {
    return `test:${testRunId}`;
  }

  static admission(input: TestRunUsageAdmission): AdmitUsageOperationInput {
    const requested = splitModelSpecifier(input.requestedModel);
    const operationId = TestRunUsageRecorder.operationId(input.testRunId);
    return {
      operationId,
      operationKind: 'test_turn',
      sourceId: input.testRunId,
      startedAt: input.startedAt,
      installationId: usageInstallationId(input.platformEnv, input.processEnv),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentLabel: input.agentLabel,
      channelId: null,
      channelLabel: null,
      conversationKind: 'direct_message',
      requesterMembershipId: input.requesterMembershipId,
      executionPrincipalId: input.agentId,
      ...modelPolicyUsage(input.modelAttribution),
      requestedProvider: requested.provider,
      requestedModel: requested.model,
      credentialRefId: input.credentialRefId,
      credentialVersion: input.credentialVersion,
    };
  }

  constructor(
    private readonly operation: TestRunUsageOperation,
    private readonly env: { platformEnv?: PlatformEnv; processEnv?: NodeJS.ProcessEnv } = {},
  ) {}

  /** Answered: the reply's reported usage. */
  completed(metadata: ChickpeaResponseMetadata | undefined, at: number, billingRunId: string | null): RecordUsageTerminalInput {
    const usage = metadata?.usage && metadata.usage.totalTokens > 0 ? metadata.usage : undefined;
    return this.terminal({
      status: 'completed',
      providerRoute: metadata?.returnedModel?.provider ?? this.operation.requestedProvider,
      returnedProvider: metadata?.returnedModel?.provider ?? null,
      returnedModel: metadata?.returnedModel?.id ?? null,
      usageCompleteness: usage ? 'complete' : 'not_reported',
      inputTokens: usage?.input ?? null,
      outputTokens: usage?.output ?? null,
      cacheReadTokens: usage?.cacheRead ?? null,
      cacheWriteTokens: usage?.cacheWrite ?? null,
      totalTokens: usage?.totalTokens ?? null,
      usageUnknownReason: usage ? null : 'usage_not_reported',
    }, at, billingRunId, usage?.cacheWrite1h ?? null);
  }

  /** Failed, or never dispatched: the ledger's charge rows under the submission say what it was billed. */
  failed(at: number, billingRunId: string | null): RecordUsageTerminalInput {
    return this.unreported('failed', 'provider_request_unknown', at, billingRunId);
  }

  /** Stopped at a deadline or by a cancellation. */
  interrupted(at: number, billingRunId: string | null): RecordUsageTerminalInput {
    return this.unreported('interrupted', 'stream_interrupted', at, billingRunId);
  }

  private unreported(
    status: 'failed' | 'interrupted',
    reason: UsageUnknownReason,
    at: number,
    billingRunId: string | null,
  ): RecordUsageTerminalInput {
    return this.terminal({
      status,
      providerRoute: this.operation.requestedProvider,
      returnedProvider: null,
      returnedModel: null,
      usageCompleteness: 'not_reported',
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      usageUnknownReason: reason,
    }, at, billingRunId);
  }

  private terminal(
    fields: Pick<
      RecordUsageTerminalInput,
      | 'status'
      | 'providerRoute'
      | 'returnedProvider'
      | 'returnedModel'
      | 'usageCompleteness'
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadTokens'
      | 'cacheWriteTokens'
      | 'totalTokens'
      | 'usageUnknownReason'
    >,
    at: number,
    billingRunId: string | null,
    cacheWrite1hTokens: number | null = null,
  ): RecordUsageTerminalInput {
    const terminal = {
      operationId: this.operation.operationId,
      executionId: this.operation.operationId,
      billingRunId,
      finishedAt: at,
      observedAt: at,
      requestedProvider: this.operation.requestedProvider,
      requestedModel: this.operation.requestedModel,
      credentialRefId: this.operation.credentialRefId,
      credentialVersion: this.operation.credentialVersion,
      ...fields,
    };
    return {
      ...terminal,
      ...estimateForRuntime({ ...terminal, cacheWrite1hTokens }, this.env.platformEnv, this.env.processEnv),
    };
  }
}
