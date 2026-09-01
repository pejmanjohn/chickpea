import type { LiveCatalog } from '../schema.ts';
import { AGENT_LIFECYCLE_CONTRACT } from './agent-lifecycle.live.ts';
import { CHANNEL_SCHEDULE_CONTRACT } from './channel-schedule.live.ts';
import { CONNECTOR_SETUP_CONTRACT } from './connector-setup.live.ts';

export const FOUNDATION_LIVE_CASES = [
  AGENT_LIFECYCLE_CONTRACT,
  CONNECTOR_SETUP_CONTRACT,
  CHANNEL_SCHEDULE_CONTRACT,
] as const;

export const PUBLIC_LIVE_CATALOG: LiveCatalog = {
  schemaVersion: 'chickpea-live-catalog/v1',
  release: 'v1.0',
  pendingContractIds: ['LC-02', 'LC-03', 'LC-05', 'LC-06', 'LC-07', 'LC-09', 'LC-10'],
  contracts: [...FOUNDATION_LIVE_CASES],
};
