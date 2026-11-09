import { z } from 'zod';

import { AGENT_ID_PATTERN } from '../../config/agent-id.ts';
import { MODEL_EFFORTS } from '../../config/model-effort.ts';
import { PROVIDER_KEY_IDS } from '../../config/provider-key-ids.ts';
import { MAX_UPLOAD_FILES } from '../../config/skill-upload.ts';

/**
 * Inputs and outputs of the 5.0 management tools. Every output is strict, so
 * the SDK's output check refuses a field the contract does not name: no
 * internal ID, revision or per-step duration can ride along unnoticed.
 */

const zText = (max: number) => z.string().min(1).max(max);
const zAgentId = z.string().regex(AGENT_ID_PATTERN).describe('An agentId from list_agents.');
const zVersion = z.string().regex(/^[a-f0-9]{16}$/);
const zModel = z.string().min(1).max(500).regex(/^[^/]+\/.+$/);
const zEffort = z.enum(MODEL_EFFORTS);
const zWhoCanEdit = z.enum(['creator_and_admins', 'all_workspace_members']);
const zRole = z.enum(['owner', 'admin', 'member']);
const zLinks = z.strictObject({ admin: z.string(), slack: z.string().optional() });
const zWhen = z.strictObject({ display: z.string(), isoUtc: z.string() });
const zAgentStatus = z.enum(['on', 'off', 'archived']);

// Inputs.

export const getAccountInput = z.strictObject({});
export const getWorkspaceInput = z.strictObject({});
export const listAgentsInput = z.strictObject({
  include: z.enum(['all', 'mine']).optional()
    .describe('all (the default) lists every Agent you can use; mine lists the ones you created.'),
});
export const getAgentInput = z.strictObject({ agentId: zAgentId });
export const listServicesInput = z.strictObject({
  search: z.string().max(120).optional().describe('Words to match in a service\'s name or description.'),
});
export const listModelsInput = z.strictObject({});
export const listMembersInput = z.strictObject({});
export const listSlackChannelsInput = z.strictObject({
  search: z.string().max(120).optional().describe('Part of a Channel name.'),
});
export const getAgentMemoryInput = z.strictObject({ agentId: zAgentId });
export const listSchedulesInput = z.strictObject({
  agentId: zAgentId.optional(),
  channelId: zText(128).optional().describe('A Slack channelId from list_slack_channels.'),
  scheduleId: zText(128).optional().describe('A scheduleId from an earlier list_schedules.'),
});
export const getSetupStatusInput = z.strictObject({
  setupToken: zText(128).describe('The setupToken a setup link came with.'),
});
export const exportAgentsInput = z.strictObject({
  agentIds: z.array(zAgentId).max(100).optional().describe('Omit to export every Agent you can edit.'),
});
export const listConnectedAppsInput = z.strictObject({});
export const getCreationStatusInput = z.strictObject({ agentId: zAgentId });

export const proposeAgentInput = z.strictObject({
  name: zText(240).refine((value) => value.trim().length > 0, 'Name the Agent.').describe('What people call the Agent, such as Support Desk.'),
  handle: zText(80).describe('The Slack handle people mention, without @.'),
  job: zText(500).describe('The Agent\'s job in one sentence. It becomes the Agent\'s description.'),
  instructions: z.string().max(100_000).describe('The Agent\'s full instructions.'),
  sampleAsk: zText(200).describe('Something the person would ask it in Slack, in their words.'),
  promisedAnswer: zText(2_000).describe('Your draft of the Agent\'s answer to sampleAsk.'),
  services: z.array(zText(128)).max(10).optional()
    .describe('Services it needs, by name or by service from list_services. Each is connected after creation.'),
  channels: z.array(zText(128)).max(20).optional()
    .describe('Slack Channels it answers in, by channelId or #name from list_slack_channels.'),
  model: zModel.optional().describe('A chat model from list_models. Omit to use the workspace default.'),
});

/** The fields `propose_agent_change` previews and `update_agent` takes. */
const zAgentChange = z.strictObject({
  name: zText(240).optional(),
  description: z.string().max(500).optional(),
  handle: zText(80).optional(),
  instructions: z.string().max(100_000).optional(),
  on: z.boolean().optional().describe('false turns the Agent off; true turns it back on.'),
  model: zModel.nullable().optional().describe('A chat model from list_models; null follows the workspace default.'),
  effort: zEffort.nullable().optional(),
  imageModel: zModel.nullable().optional().describe('An image model from list_models; null follows the workspace default.'),
  whoCanEdit: zWhoCanEdit.optional(),
});

export const proposeAgentChangeInput = z.strictObject({
  agentId: zAgentId,
  version: zVersion.describe('The version get_agent returned.'),
  change: zAgentChange.refine((change) => Object.keys(change).length > 0, 'Name at least one field to change.'),
});

const zIdempotencyKey = zText(256).describe('Any unique string. Reuse it only to retry this exact call.');

/**
 * `create_agent`'s input. The Create button `propose_agent` returns sends
 * these arguments unchanged.
 */
export const createAgentInputSchema = z.strictObject({
  agentId: zAgentId.optional().describe('Omit to derive one from the name.'),
  name: zText(240).refine((value) => value.trim().length > 0, 'Name the Agent.'),
  handle: zText(80).optional().describe('The Slack handle people mention, without @.'),
  description: z.string().max(500).optional().describe('The Agent\'s job in one sentence.'),
  instructions: z.string().max(100_000),
  model: zModel.optional().describe('A chat model from list_models. Omit to use the workspace default.'),
  effort: zEffort.optional(),
  whoCanEdit: zWhoCanEdit.optional(),
  skills: z.array(z.strictObject({
    name: zText(64),
    description: z.string().max(2_000),
    instructions: z.string().max(100_000),
  })).max(100).optional(),
  firstAsk: zText(200).optional().describe('What the person should ask it first; its hello in Slack ends by inviting it.'),
  channels: z.array(zText(128)).max(20).optional().describe('Slack Channels it answers in, by channelId or #name.'),
  createEvenIfSimilar: z.boolean().optional()
    .describe('true only after the person chose a new Agent over a similar one this tool returned.'),
  idempotencyKey: zIdempotencyKey,
});

/** `update_agent`'s input; `propose_agent_change` returns it. */
export const updateAgentInputSchema = z.strictObject({
  agentId: zAgentId,
  version: zVersion.describe('The version get_agent returned.'),
  ...zAgentChange.shape,
  idempotencyKey: zIdempotencyKey,
});

const zAgentVersion = zVersion.describe('The version get_agent returned.');
const zChannelId = zText(128).describe('A Slack channelId from list_slack_channels.');
const zScheduleId = zText(128).describe('A scheduleId from list_schedules.');
const zScheduleVersion = zVersion.describe('The version list_schedules returned for it.');
const zConnectionIds = z.array(zText(128)).max(100)
  .describe('connectionIds from get_agent the task uses, or [] for none. Required for a new schedule or a changed task.');

export const updateAgentMemoryInput = z.strictObject({
  agentId: zAgentId,
  version: zVersion.describe('The version get_agent_memory returned.'),
  body: z.string().max(65_536).describe('The whole new memory text; it replaces the old one.'),
  idempotencyKey: zIdempotencyKey,
});
export const archiveAgentInput = z.strictObject({
  agentId: zAgentId,
  version: zAgentVersion,
  newDefaultAgentId: zAgentId.optional().describe('When archiving the workspace default Agent, the Agent that becomes the default.'),
  idempotencyKey: zIdempotencyKey,
});
export const restoreAgentInput = z.strictObject({ agentId: zAgentId, version: zAgentVersion, idempotencyKey: zIdempotencyKey });
export const addAgentToChannelInput = z.strictObject({ agentId: zAgentId, channelId: zChannelId, idempotencyKey: zIdempotencyKey });
export const saveChannelSettingsInput = z.strictObject({
  channelId: zChannelId,
  label: z.string().max(240).optional().describe('Chickpea\'s name for the Channel. Omit to keep the current one.'),
  on: z.boolean().describe('false turns Chickpea off in the Channel; true turns it on.'),
  idempotencyKey: zIdempotencyKey,
});
export const importSkillFromGithubInput = z.strictObject({
  agentId: zAgentId,
  source: zText(2_000).describe('The public GitHub URL or owner/repo the person gave, unchanged.'),
  skillName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).optional()
    .describe('A skill the person named alongside a repository or folder.'),
  replaceExisting: z.boolean().optional().describe('true only when the person wants a same-name skill replaced.'),
  idempotencyKey: zIdempotencyKey,
});
export const uploadSkillFilesInput = z.strictObject({
  agentId: zAgentId,
  // One flat item, not a union: MCP clients handle a bare anyOf poorly.
  files: z.array(z.strictObject({
    name: zText(255).describe('The file name, such as SKILL.md or skills.zip; its extension decides how it is read.'),
    text: z.string().min(1).optional().describe('A markdown file\'s exact text. Send text or base64, not both.'),
    base64: z.string().min(4).optional().describe('A .zip or .skill archive\'s bytes, base64-encoded.'),
  }).refine((file) => (file.text === undefined) !== (file.base64 === undefined), 'Send text or base64, not both.'))
    .min(1).max(MAX_UPLOAD_FILES),
  replaceExisting: z.boolean().optional().describe('true only when the person wants same-name skills replaced.'),
  idempotencyKey: zIdempotencyKey,
});
export const setAgentSkillInput = z.strictObject({
  agentId: zAgentId,
  skill: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).describe('A skill name from get_agent.'),
  action: z.enum(['turn_on', 'turn_off', 'remove']),
  idempotencyKey: zIdempotencyKey,
});
export const saveScheduleInput = z.strictObject({
  agentId: zAgentId,
  channelId: zChannelId.optional().describe('Where it posts: a Channel the Agent answers in. Required for a new schedule.'),
  scheduleId: zScheduleId.optional().describe('Omit to create a schedule; set to change one.'),
  version: zScheduleVersion.optional().describe('Required with scheduleId: the version list_schedules returned.'),
  name: zText(200),
  description: z.string().max(2_000).optional(),
  task: zText(20_000).describe('What the Agent does on each run, as you would ask it in Slack.'),
  // One flat object, not a union: MCP clients handle a bare anyOf poorly.
  when: z.strictObject({
    cron: zText(200).optional().describe('A five-field cron expression, for a repeating schedule.'),
    once: zText(64).optional().describe('A local date and time, such as 2026-12-01T09:00, to run once.'),
    inMinutes: z.number().int().min(1).max(532_800).optional().describe('Run once, this many minutes from now.'),
    keep: z.literal(true).optional().describe('Keep the current timing; only with scheduleId.'),
  }).refine((when) => Object.keys(when).length === 1, 'Set exactly one of cron, once, inMinutes or keep.'),
  timezone: zText(100).describe('An IANA time zone, such as America/New_York.'),
  post: z.enum(['always', 'when_changed']).describe('when_changed posts only when the result differs from the last run.'),
  requiredConnections: zConnectionIds.optional(),
  idempotencyKey: zIdempotencyKey,
});
export const pauseScheduleInput = z.strictObject({
  scheduleId: zScheduleId,
  version: zScheduleVersion,
  turnOff: z.boolean().optional().describe('true turns it off instead of pausing it.'),
  idempotencyKey: zIdempotencyKey,
});
export const resumeScheduleInput = z.strictObject({ scheduleId: zScheduleId, version: zScheduleVersion, idempotencyKey: zIdempotencyKey });
export const runScheduleNowInput = z.strictObject({ scheduleId: zScheduleId, idempotencyKey: zIdempotencyKey });
export const takeOverScheduleInput = z.strictObject({
  scheduleId: zScheduleId,
  version: zScheduleVersion,
  requiredConnections: zConnectionIds.optional(),
  idempotencyKey: zIdempotencyKey,
});
export const setWorkspaceModelInput = z.strictObject({
  role: z.enum(['chat', 'image', 'coding']),
  model: zModel.nullable().describe('A model from list_models; null clears the image or coding model.'),
  effort: zEffort.optional().describe('Chat and coding only. Omit for the model\'s standard effort.'),
  version: zVersion.describe('The version list_models returned for this role.'),
  idempotencyKey: zIdempotencyKey,
});
export const connectModelProviderInput = z.strictObject({
  provider: z.enum(PROVIDER_KEY_IDS),
  replaceExisting: z.boolean().optional().describe('true when a key is stored and the person wants the link to replace it.'),
});
export const confirmChangeInput = z.strictObject({
  confirmToken: zText(128).describe('The confirmToken a needs_confirmation result returned.'),
});
export const undoChangeInput = z.strictObject({
  undoToken: zText(128).describe('The undoToken a change returned.'),
  idempotencyKey: zIdempotencyKey,
});

// Outputs.

export const getAccountOutput = z.strictObject({
  id: z.string().min(1).regex(/\S/).describe('Opaque profile identifier, unique within this app and unchanged across token refresh, reconnection, and display-metadata changes. Never reassigned to another profile.'),
  name: z.string().optional().describe('Display name for the authenticated profile.'),
  email: z.string().optional().describe('Email address for display; not used as the profile identity.'),
  nickname: z.string().optional().describe('A useful label that helps users distinguish connected profiles.'),
});

export const getWorkspaceOutput = z.strictObject({
  name: z.string().optional(),
  you: z.strictObject({ name: z.string().optional(), role: zRole }),
  agentCount: z.number().int().nonnegative(),
  adminUrl: z.string().optional(),
  adminOnly: z.array(z.strictObject({ what: z.string(), url: z.string().optional() })),
});

const zAgentRow = z.strictObject({
  agentId: z.string(),
  name: z.string(),
  handle: z.string().optional(),
  description: z.string().optional(),
  status: zAgentStatus,
  canEdit: z.boolean(),
  needsAttention: z.array(z.string()),
  links: zLinks.optional(),
});

export const listAgentsOutput = z.strictObject({
  agents: z.array(zAgentRow),
  canCreate: z.boolean(),
});

const zSlackPresence = z.enum(['ready', 'joining', 'needs_attention', 'not_in_slack']);

export const getAgentOutput = z.strictObject({
  agentId: z.string(),
  name: z.string(),
  handle: z.string().optional(),
  description: z.string().optional(),
  status: zAgentStatus,
  version: zVersion,
  instructions: z.string(),
  whoCanEdit: zWhoCanEdit,
  model: z.strictObject({
    model: z.string().nullable(),
    source: z.enum(['pinned', 'workspace_default']),
    effort: z.string().nullable(),
    imageModel: z.string().nullable(),
    imageSource: z.enum(['pinned', 'workspace_default']),
  }),
  slack: z.strictObject({
    presence: zSlackPresence,
    problem: z.string().optional(),
    ownApp: z.boolean(),
    groupDms: z.enum(['yes', 'no', 'unknown']),
  }),
  skills: z.array(z.strictObject({
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    from: z.enum(['github', 'suggested', 'custom']),
  })),
  connections: z.array(z.strictObject({
    connectionId: z.string(),
    name: z.string(),
    kind: z.enum(['service', 'custom_api', 'custom_mcp']),
    owner: z.enum(['team', 'member']).optional(),
    status: z.enum(['ready', 'waiting_for_setup', 'needs_attention', 'off']),
    custom: z.strictObject({
      hosts: z.array(z.string()).optional(),
      pathPrefixes: z.array(z.string()).optional(),
      methods: z.array(z.string()).optional(),
      headerName: z.string().optional(),
      url: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
      guide: z.string().optional(),
    }).optional(),
  })),
  websiteLogins: z.array(z.strictObject({ loginId: z.string(), site: z.string() })),
  repositories: z.array(z.strictObject({ repository: z.string() })),
  channels: z.array(z.strictObject({ channelId: z.string(), name: z.string().optional() })),
  links: zLinks.optional(),
});

export const listServicesOutput = z.strictObject({
  services: z.array(z.strictObject({ service: z.string(), name: z.string(), description: z.string() })),
  count: z.number().int().nonnegative(),
});

const zRoleDefault = (withEffort: boolean) => z.strictObject({
  model: z.string().nullable(),
  ...(withEffort ? { effort: z.string().nullable() } : {}),
  version: zVersion,
});

export const listModelsOutput = z.strictObject({
  models: z.array(z.strictObject({
    model: z.string(),
    kind: z.enum(['chat', 'image']),
    name: z.string().optional(),
    efforts: z.array(z.string()).optional(),
  })),
  workspaceDefaults: z.strictObject({
    chat: zRoleDefault(true),
    image: zRoleDefault(false),
    coding: zRoleDefault(true),
  }).optional(),
  providers: z.array(z.strictObject({
    provider: z.string(),
    ready: z.boolean(),
    key: z.enum(['yours', 'chickpea', 'none']),
    replaceable: z.boolean(),
  })).optional(),
});

export const listMembersOutput = z.strictObject({
  members: z.array(z.strictObject({
    slackUserId: z.string().optional(),
    name: z.string().optional(),
    role: zRole,
    status: z.enum(['active', 'suspended', 'removed']),
    adminUrl: z.string().optional().describe('Present when the member has no Slack user: change them in Admin.'),
  })),
});

export const listSlackChannelsOutput = z.strictObject({
  channels: z.array(z.strictObject({
    channelId: z.string(),
    name: z.string().optional(),
    private: z.boolean().optional(),
    chickpeaInChannel: z.boolean().optional(),
    settings: z.strictObject({ label: z.string().optional(), on: z.boolean() }).optional(),
    agents: z.array(z.strictObject({ agentId: z.string(), name: z.string(), status: z.enum(['on', 'joining', 'needs_attention']) })),
  })),
  complete: z.boolean().describe('false when Slack\'s Channel list was cut short or could not be read.'),
});

export const getAgentMemoryOutput = z.strictObject({ body: z.string(), version: zVersion });

export const listSchedulesOutput = z.strictObject({
  schedules: z.array(z.strictObject({
    scheduleId: z.string(),
    name: z.string().optional(),
    agent: z.strictObject({ agentId: z.string(), name: z.string().optional() }),
    where: z.strictObject({ kind: z.enum(['channel', 'dm']), channelId: z.string().optional(), label: z.string() }),
    cadence: z.string(),
    timezone: z.string(),
    nextRun: zWhen.nullable(),
    lastRun: z.strictObject({
      outcome: z.enum(['succeeded', 'failed', 'skipped', 'running']),
      problem: z.string().optional(),
    }).optional(),
    state: z.enum(['on', 'paused', 'off', 'done', 'waiting_for_access', 'deleted']),
    why: z.string().optional(),
    runsAs: z.strictObject({ name: z.string().optional(), you: z.boolean() }),
    post: z.enum(['always', 'when_changed']),
    task: z.string().optional(),
    version: zVersion,
  })),
});

export const getSetupStatusOutput = z.strictObject({
  status: z.enum(['waiting', 'opened', 'signing_in', 'done', 'failed', 'cancelled', 'expired']),
  what: z.string(),
  expires: zWhen.optional(),
  agent: z.strictObject({ agentId: z.string(), name: z.string().optional() }).optional(),
});

/** The recipe v2 document, unchanged from `export_workspace_recipe`. */
export const exportAgentsOutput = z.looseObject({ schemaVersion: z.number() });

export const listConnectedAppsOutput = z.strictObject({
  apps: z.array(z.strictObject({
    appId: z.string(),
    name: z.string().optional(),
    connected: z.strictObject({ display: z.string() }),
    lastActive: z.strictObject({ display: z.string() }).optional(),
    thisApp: z.boolean(),
  })),
});

export const proposeAgentOutput = z.strictObject({
  proposal: z.strictObject({
    name: z.string(),
    handle: z.string(),
    handleAvailable: z.boolean(),
    job: z.string(),
    sampleExchange: z.strictObject({ ask: z.string(), answer: z.string() }),
    needs: z.array(z.strictObject({ service: z.string(), name: z.string(), connected: z.literal(false) })),
    answersIn: z.array(z.strictObject({ channelId: z.string(), name: z.string().optional() })),
    model: z.string().optional(),
  }),
  create: z.strictObject({ tool: z.literal('create_agent'), arguments: createAgentInputSchema }),
  issues: z.array(z.string()),
});

/** One `summarizeTextChange` entry: where an edit sits and a short quote of it. */
const zQuote = z.union([
  z.strictObject({
    kind: z.literal('section'),
    action: z.enum(['adds', 'removes']),
    heading: z.string(),
    quote: z.string(),
    words: z.number(),
    quotedWhole: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('text'),
    action: z.enum(['adds', 'removes', 'changes']),
    place: z.union([
      z.strictObject({ kind: z.literal('heading'), heading: z.string() }),
      z.strictObject({ kind: z.enum(['start', 'end', 'none']) }),
    ]),
    quote: z.string(),
    words: z.number(),
    quotedWhole: z.boolean(),
  }),
]);

export const proposeAgentChangeOutput = z.strictObject({
  agent: z.strictObject({ name: z.string(), handle: z.string().optional() }),
  changes: z.array(z.strictObject({
    field: z.enum(['name', 'description', 'handle', 'instructions', 'on', 'model', 'effort', 'imageModel', 'whoCanEdit']),
    before: z.union([z.string(), z.boolean()]).nullable().optional(),
    after: z.union([z.string(), z.boolean()]).nullable().optional(),
    quotes: z.array(zQuote),
  })),
  save: z.strictObject({ tool: z.literal('update_agent'), arguments: updateAgentInputSchema }),
  needsConfirmation: z.boolean(),
});

/**
 * What every 5.0 write returns. Only handles a later call takes appear:
 * agentId, confirmToken, undoToken and setupToken, never a revision.
 */
const changeResultShape = {
  status: z.enum(['done', 'unchanged', 'needs_confirmation', 'needs_setup', 'needs_choice', 'similar_agent_exists'])
    .describe('needs_confirmation: nothing changed yet; show confirmation.preview and call confirm_change only after the person agrees.'),
  summary: z.string().describe('One plain sentence to tell the person.'),
  nextStep: z.string().optional().describe('For you: what to do next.'),
  agent: z.strictObject({
    agentId: z.string(),
    name: z.string(),
    handle: z.string().optional(),
    links: zLinks.optional(),
  }).optional(),
  version: zVersion.optional().describe('The new version of what changed, for your next change to it.'),
  confirmation: z.strictObject({
    confirmToken: z.string(),
    preview: z.string().describe('Markdown to show the person before they agree.'),
    expiresAt: z.string().describe('After this time confirm_change refuses the token; call the tool again.'),
  }).optional(),
  setup: z.strictObject({
    url: z.string().describe('The Chickpea page to give the person; they finish there.'),
    setupToken: z.string().optional().describe('For get_setup_status.'),
    what: z.string(),
    expiresAt: z.string().optional(),
  }).optional(),
  undoToken: z.string().optional().describe('Present when undo_change can reverse this change.'),
  warnings: z.array(z.string()).optional(),
  matches: z.array(z.strictObject({ agentId: z.string(), name: z.string(), handle: z.string().optional() })).optional()
    .describe('similar_agent_exists: the Agents that already look like this one.'),
};

export const changeResultOutput = z.strictObject(changeResultShape);

export const importSkillFromGithubOutput = z.strictObject({
  ...changeResultShape,
  skill: z.strictObject({ name: z.string(), description: z.string(), sourceUrl: z.string() }).optional(),
  choose: z.array(z.strictObject({ name: z.string(), description: z.string(), sourceUrl: z.string() })).optional()
    .describe('needs_choice: the skills the source holds; call again with the chosen sourceUrl as source.'),
});

export const uploadSkillFilesOutput = z.strictObject({
  ...changeResultShape,
  added: z.array(z.string()),
  replaced: z.array(z.string()),
  unchanged: z.array(z.string()),
  conflicts: z.array(z.string()).describe('Same name, different content: left as they are unless replaceExisting is true.'),
  leftOut: z.array(z.strictObject({ file: z.string(), why: z.string() })),
});

export const getCreationStatusOutput = z.strictObject({
  stage: z.enum(['joining', 'said_hello', 'ready', 'needs_attention']),
  agent: z.strictObject({ name: z.string(), handle: z.string().optional() }),
  channels: z.enum(['none', 'joining', 'joined', 'needs_attention']),
  slackUrl: z.string().optional(),
  problem: z.string().optional(),
});


// explain_agent and check_agent.

const zPlace = zText(128).optional()
  .describe('dm (the default) is the person\'s direct messages with the Agent; a channelId from get_agent is one of its Channels.');
const zAsPerson = zText(128).optional()
  .describe('A slackUserId from list_members: as that person. Owners and Admins only; omit for yourself.');

export const explainAgentInput = z.strictObject({ agentId: zAgentId, place: zPlace, asPerson: zAsPerson });
export const checkAgentInput = z.strictObject({ agentId: zAgentId, place: zPlace, asPerson: zAsPerson });

const zTokens = z.number().int().nonnegative();
const zAgentName = z.strictObject({ name: z.string(), handle: z.string().optional() });
const zWhere = z.strictObject({
  kind: z.enum(['dm', 'channel']),
  channelId: z.string().optional(),
  name: z.string().optional(),
});
const zPerson = z.strictObject({ name: z.string().optional(), you: z.boolean() });

export const explainAgentOutput = z.strictObject({
  agent: zAgentName,
  place: zWhere,
  person: zPerson,
  prompt: z.array(z.strictObject({
    part: z.enum(['chickpea', 'instructions', 'skill', 'memory', 'connection_guide']),
    title: z.string(),
    /** What this part adds before anyone speaks. */
    tokens: zTokens,
    text: z.string().optional(),
    /** A skill's or guide's full text, which loads only when the Agent uses it. */
    whenUsed: z.strictObject({ tokens: zTokens }).optional(),
  })),
  tools: z.array(z.strictObject({
    group: z.string(),
    connectionId: z.string().optional(),
    tools: z.array(z.string()).describe('Tool names; * is every tool of another person\'s own account, which Chickpea does not name.'),
    tokens: zTokens.describe('Counted once: connection_request, which every API connection uses, is in the Chickpea group.'),
    missing: z.array(z.strictObject({
      tool: z.string().describe('A tool name, or * for every tool of the group.'),
      why: z.enum(['not_chosen', 'not_discovered', 'needs_attention', 'not_connected', 'not_set_up']),
      detail: z.string().optional(),
    })),
  })),
  model: z.strictObject({
    model: z.string().nullable(),
    source: z.enum(['pinned', 'workspace_default']),
    effort: z.string().nullable(),
    canRun: z.boolean(),
    why: z.string().optional(),
  }),
  contextBudget: z.strictObject({
    tokens: zTokens.describe('Tokens before anyone speaks: the prompt plus every tool definition.'),
    top: z.array(z.strictObject({ what: z.string(), tokens: zTokens })).max(3),
    estimate: z.string().describe('How the tokens were counted.'),
  }),
});

const zFix = z.union([
  z.strictObject({ label: z.string(), url: z.string() }),
  z.strictObject({ label: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }),
]);

export const checkAgentOutput = z.strictObject({
  agent: zAgentName,
  place: zWhere,
  person: zPerson,
  healthy: z.boolean().describe('false when any check is failing.'),
  checks: z.array(z.strictObject({
    part: z.enum(['connection', 'model', 'slack', 'channel', 'schedule', 'repository', 'website_login', 'admission']),
    name: z.string(),
    status: z.enum(['ok', 'warning', 'failing', 'unknown']),
    detail: z.string(),
    fix: zFix.optional(),
    connectionId: z.string().optional(),
    channelId: z.string().optional(),
    scheduleId: z.string().optional(),
    loginId: z.string().optional(),
  })),
});
