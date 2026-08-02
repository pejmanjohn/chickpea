/** App-owned correlation stored only in TurnJob state; never serialized to traces. */
export interface WorkTraceCorrelation {
  runId: string;
  runExecutionId: string;
  mode: 'observe' | 'enforce';
}
