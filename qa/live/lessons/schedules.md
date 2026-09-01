# Channel schedule verification lessons

LC-08 separates routine creation, Slack acknowledgement, scheduled execution, Slack delivery, and cleanup. A deployed Worker or a saved `RoutineDefinition` proves only part of the journey.

## Create and deliver

The verifier finds the run-marked Routine and requires `state: active`. It then matches one acknowledgement and one result in Slack history using `ts`, `channel`, `thread_ts`, and the run-marked text. The durable `RoutineRun` must be `succeeded`, have `deliveryStatus: delivered`, and point to the same Slack message timestamp.

Missing delivery fails even when the Routine exists. A second matching result, a result in another thread, or a Slack message without the durable occurrence also fails.

## Pause and resume

Pause and resume use the Routine's actual `state` and `version` plus `routine.pause` and `routine.resume` audit events. The version advances twice. A scheduled occurrence after pause must not deliver, and an occurrence after resume must deliver. The saved `scheduleJson` must remain unchanged.

Run now requires one `RoutineRun` with `triggerSource: run_now`, one Slack delivery, and no change to `nextRunAt`.

## Cleanup and live limits

Cleanup deletes the exact Routine ID and reads it back as absent. It never deletes by display name.

The current Channel delivery implementation posts scheduled Channel results at the Channel top level, while LC-08's proposed contract requires the origin thread. The live case should expose that mismatch as a product failure. The dedicated QA target is also not drained or fixture-complete, so no live schedule mutation is authorized yet.
