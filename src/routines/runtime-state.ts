let nodeSchedulerReady = false;

/** True only while the production Node scheduler is running. */
export function nodeRoutineSchedulerAvailable(): boolean {
  return nodeSchedulerReady;
}

/** Node lifecycle hook; imports alone never make scheduling available. */
export function setNodeRoutineSchedulerAvailable(available: boolean): void {
  nodeSchedulerReady = available;
}
