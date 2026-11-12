import type { z } from 'zod';

import { resolveConnectorCatalogPreset, type ConnectorCatalogPreset, type ConnectorPreset } from '../../config/presets.ts';
import { composioHeader, MANAGED_CONNECTOR_CATALOG } from '../../connections/catalog/index.ts';
import { fail } from './conventions.ts';
import { readWorkspace, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';

/**
 * `get_service` (F6): what one catalog service can do before anyone connects
 * it, from the catalog alone. A managed service's capability headers say
 * which tools read and which write; an MCP server lists its tools only after
 * sign-in; an API preset's methods and hosts are its requests.
 */

type Out<T extends z.ZodType> = z.infer<T>;
type Service = Out<typeof schemas.getServiceOutput>;
type Capability = NonNullable<Service['capabilities']>[number];
/** A reviewed connector (BugSnag, Meta Ads) is marked by Chickpea's review, so its practice step is Admin's. */
type Described = Omit<Service, 'service' | 'name' | 'description' | 'account' | 'nextStep'> & { reviewed?: true };

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

const PRACTICE: Readonly<Record<Service['practice'], string>> = {
  reads_ready: 'A practice run can use its read actions.',
  needs_read_marks: 'Once someone connects it, get_agent lists its tools under tools, and a practice run leaves it out until update_connection marks the ones that only read with readTools. Mark only the tools the person confirms only read.',
  not_in_practice: 'A practice run leaves it out, since none of its actions only reads; ask the Agent in Slack to try it.',
  get_only: 'A practice run sends it only GET and HEAD requests.',
};

const REVIEWED_PRACTICE = 'Its tools are listed once someone connects it, and a practice run leaves it out until they are chosen on the Agent\'s page in Admin; it then uses the ones Chickpea knows only read.';
/** Who marks a connection's tools, for a member: only an Owner or Admin changes a team account. */
const MEMBER_MARKS = 'The person can mark the tools of their own account; only an Owner or Admin marks a team account\'s.';

export async function getService(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.getServiceInput>,
): Promise<Service> {
  const { snapshot } = await readWorkspace(deps);
  const preset = resolveConnectorCatalogPreset(input.service);
  if (!preset) {
    fail('not_found', `Chickpea does not list a service called ${input.service}.`, {
      nextStep: 'Call list_services for the services Chickpea knows.',
    });
  }
  const described = describe(preset);
  const member = snapshot.caller.role === 'member';
  const owner = member ? 'owner me (only an Owner or Admin connects a team account)' : 'owner team or me';
  const practice = described.reviewed ? REVIEWED_PRACTICE : PRACTICE[described.practice];
  return {
    service: preset.id,
    name: preset.name,
    description: preset.description,
    signIn: described.signIn,
    // Every catalog service can be either; connect_service asks which.
    account: { team: true, own: true },
    ...(described.capabilities ? { capabilities: described.capabilities } : {}),
    capabilitiesKnown: described.capabilitiesKnown,
    practice: described.practice,
    nextStep: `connect_service with service ${preset.id}, an agentId and ${owner} connects it. ${practice}${
      member && !described.reviewed && described.practice === 'needs_read_marks' ? ` ${MEMBER_MARKS}` : ''}`,
  };
}

function describe(preset: ConnectorCatalogPreset): Described {
  if ('managedToolkit' in preset) {
    const capabilities: Capability[] = (MANAGED_CONNECTOR_CATALOG.connector(preset.managedToolkit)?.capabilities ?? [])
      .map(({ toolName, effect, sideEffectLabel }) => effect === 'read'
        ? { name: toolName, does: 'read' as const }
        : { name: toolName, does: 'write' as const, ...(sideEffectLabel ? { changes: sideEffectLabel } : {}) });
    return {
      signIn: composioHeader(preset.managedToolkit)?.auth.mode === 'api_key' ? 'key' : 'oauth',
      capabilities,
      capabilitiesKnown: 'now',
      // A practice run keeps a managed connection's read capabilities (test-run-plan.ts).
      practice: capabilities.some(({ does }) => does === 'read') ? 'reads_ready' : 'not_in_practice',
    };
  }
  if (preset.url !== undefined && preset.auth) {
    return {
      signIn: mcpSignIn(preset.auth),
      capabilitiesKnown: 'after_connecting',
      // update_connection marks its reads, or for a reviewed connector its tool choices in Admin carry Chickpea's own.
      practice: 'needs_read_marks',
      ...(preset.toolAccessMode === 'review' ? { reviewed: true as const } : {}),
    };
  }
  const { api } = preset as Extract<ConnectorPreset, { api: unknown }>;
  const paths = api.pathPrefixes?.length ? api.pathPrefixes : [''];
  const where = api.hosts.flatMap((host) => paths.map((path) => `${host}${path}`)).join(', ');
  return {
    signIn: api.oauth?.provider === 'google' ? 'google' : 'key',
    capabilities: api.methods.map((method) => ({
      name: `${method} ${where}`,
      does: READ_METHODS.has(method.toUpperCase()) ? 'read' as const : 'write' as const,
    })),
    capabilitiesKnown: 'now',
    practice: 'get_only',
  };
}

function mcpSignIn(auth: NonNullable<ConnectorPreset['auth']>): Service['signIn'] {
  if (auth.kind === 'oauth') return 'oauth';
  if (auth.kind === 'none') return 'none';
  return 'key';
}

const SIGN_IN: Readonly<Record<Service['signIn'], string>> = {
  oauth: 'signs in to the service',
  key: 'connects with a key',
  none: 'needs no sign-in',
  google: 'signs in with Google',
};

/** The text block: one status line and the next step; the actions themselves are in structuredContent. */
export function serviceText(output: Service): string {
  const reads = output.capabilities?.filter(({ does }) => does === 'read').length ?? 0;
  const actions = output.capabilities
    ? `${output.capabilities.length} actions, ${reads} read and ${output.capabilities.length - reads} write`
    : 'its tools are listed after it is connected';
  return `${output.name} (service ${output.service}) ${SIGN_IN[output.signIn]}; ${actions}. ${output.nextStep}`;
}
