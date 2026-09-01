import type { LiveCatalog } from '../schema.ts';
import { AGENT_LIFECYCLE_CONTRACT } from './agent-lifecycle.live.ts';
import { AGENT_MEMORY_CONTRACT } from './agent-memory.live.ts';
import { AVATAR_PARITY_CONTRACT } from './avatar-parity.live.ts';
import { CHANNEL_SCHEDULE_CONTRACT } from './channel-schedule.live.ts';
import { CONNECTION_OWNERSHIP_REVOCATION_CONTRACT } from './connector-ownership-revocation.live.ts';
import { CONNECTOR_SETUP_CONTRACT } from './connector-setup.live.ts';
import { DM_SCHEDULE_PRIVACY_CONTRACT } from './dm-schedule-privacy.live.ts';
import { INSTALLATION_APP_HOME_AUTH_CONTRACT } from './installation-app-home-auth.live.ts';
import { SKILL_MANAGEMENT_CONTRACT } from './skill-management.live.ts';
import { SLACK_ROUTING_CONTRACT } from './slack-routing.live.ts';

export const FOUNDATION_LIVE_CASES = [
  AGENT_LIFECYCLE_CONTRACT,
  CONNECTOR_SETUP_CONTRACT,
  CHANNEL_SCHEDULE_CONTRACT,
] as const;

export const PUBLIC_LIVE_CATALOG: LiveCatalog = {
  schemaVersion: 'chickpea-live-catalog/v1',
  release: 'v1.1',
  pendingContractIds: [],
  contracts: [
    AGENT_LIFECYCLE_CONTRACT,
    AVATAR_PARITY_CONTRACT,
    SLACK_ROUTING_CONTRACT,
    CONNECTOR_SETUP_CONTRACT,
    CONNECTION_OWNERSHIP_REVOCATION_CONTRACT,
    SKILL_MANAGEMENT_CONTRACT,
    AGENT_MEMORY_CONTRACT,
    CHANNEL_SCHEDULE_CONTRACT,
    DM_SCHEDULE_PRIVACY_CONTRACT,
    INSTALLATION_APP_HOME_AUTH_CONTRACT,
  ],
};
