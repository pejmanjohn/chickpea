import type { ProviderId } from '../config/types.ts';

export interface ModelCallTelemetry {
  providerId: ProviderId;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TurnTelemetry {
  firstVisibleResponseKind: 'slack_progress' | 'slack_status';
  timeToFirstVisibleResponseMs: number;
  providerId: ProviderId;
  model: string;
  totalLatencyMs: number;
  deliveryMode?: 'stream' | 'fallback_post';
  degradations?: string[];
}

export class TelemetryStore {
  readonly modelCalls: ModelCallTelemetry[] = [];
  readonly turns: TurnTelemetry[] = [];

  recordModelCall(call: ModelCallTelemetry): void {
    this.modelCalls.push(call);
  }

  recordTurn(turn: TurnTelemetry): void {
    this.turns.push(turn);
  }
}
