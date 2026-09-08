import * as v from 'valibot';

export const RoutineIntentSchema = v.strictObject({
  action: v.picklist([
    'none', 'create', 'edit', 'show', 'pause', 'resume', 'disable', 'run', 'clone', 'delete',
  ]),
  routineId: v.optional(v.string()),
  routineName: v.optional(v.string()),
  name: v.optional(v.string()),
  description: v.optional(v.string()),
  taskText: v.optional(v.string()),
  triggerKind: v.optional(v.picklist(['schedule', 'once'])),
  scheduleExpression: v.optional(v.string()),
  timezone: v.optional(v.string()),
  timezoneWasDefaulted: v.optional(v.boolean()),
  outputPolicy: v.optional(v.picklist(['post', 'post_on_change'])),
});
