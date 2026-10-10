import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentAppLifecycle } from '../src/config/types.ts';
import {
  type AgentAppEvent,
  type AgentAppTransition,
  CREATE_SETTLE_MS,
  createIsStale,
  initialAgentApp,
  isRefusal,
  nextStep,
  transition,
} from '../src/slack/agent-apps/lifecycle.ts';

const T0 = 1_800_000_000_000;
const AT = T0 + 1_000;
const APP = { appId: 'A0C8APP', clientId: '1.2' };
const CONSENT = { nonceDigest: 'd1', owner: 'UOWNER', expiresAt: AT + 900_000 };

const states = {
  releasing_handle: { state: 'releasing_handle', at: T0, startedBy: 'UOWNER' },
  creating: { state: 'creating', at: T0, startedBy: 'UOWNER', manifestFingerprint: 'f1' },
  creating_stale: { state: 'creating', at: T0 - CREATE_SETTLE_MS, startedBy: 'UOWNER', manifestFingerprint: 'f1' },
  created: { state: 'created', at: T0, startedBy: 'UOWNER', app: APP },
  urls_set: { state: 'urls_set', at: T0, startedBy: 'UOWNER', app: APP },
  icon_set: { state: 'icon_set', at: T0, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar' },
  awaiting_consent: {
    state: 'awaiting_consent', at: T0, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.1' },
  },
  awaiting_consent_opened: {
    state: 'awaiting_consent', at: T0, startedBy: 'UOWNER', app: APP, icon: 'agent_avatar', allowDm: { channelId: 'D1', ts: '1.1' }, consent: CONSENT,
  },
  active: { state: 'active', at: T0, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: T0, installedBy: 'UOWNER' },
  uninstalling_uninstall: { state: 'uninstalling', at: T0, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'uninstall' },
  uninstalling_delete: { state: 'uninstalling', at: T0, startedBy: 'UOWNER', app: APP, next: 'delete' },
  attention_no_app: { state: 'needs_attention', at: T0, startedBy: 'UOWNER', reason: 'ambiguous_create', resume: 'creating' },
  attention_handle: { state: 'needs_attention', at: T0, startedBy: 'UOWNER', reason: 'handle_release_failed', resume: 'releasing_handle' },
  attention_created: { state: 'needs_attention', at: T0, startedBy: 'UOWNER', reason: 'urls_refused', resume: 'created', app: APP },
  attention_removed: {
    state: 'needs_attention', at: T0, startedBy: 'UOWNER', reason: 'app_removed', resume: 'icon_set', app: APP, icon: 'default_avatar',
  },
  attention_uninstall: {
    state: 'needs_attention', at: T0, startedBy: 'UOWNER', reason: 'uninstall_failed', resume: 'uninstalling', app: APP, botUserId: 'UBOT',
  },
} satisfies Record<string, AgentAppLifecycle>;

const events = {
  handle_released: { type: 'handle_released', at: AT, manifestFingerprint: 'f2' },
  handle_release_refused: { type: 'handle_release_refused', at: AT },
  handle_permission_missing: { type: 'handle_permission_missing', at: AT },
  created: { type: 'created', at: AT, app: APP },
  create_refused: { type: 'create_refused', at: AT, reason: 'create_refused' },
  create_busy: { type: 'create_refused', at: AT, reason: 'slack_busy' },
  create_ambiguous: { type: 'create_ambiguous', at: AT },
  recreate: { type: 'recreate', at: AT, manifestFingerprint: 'f3' },
  urls_set: { type: 'urls_set', at: AT },
  urls_refused: { type: 'urls_refused', at: AT },
  config_token_needed: { type: 'config_token_needed', at: AT },
  icon_set: { type: 'icon_set', at: AT, icon: 'default_avatar' },
  allow_dm_posted: { type: 'allow_dm_posted', at: AT, channelId: 'D1', ts: '1.1' },
  consent_opened: { type: 'consent_opened', at: AT, ...CONSENT },
  consent_granted: { type: 'consent_granted', at: AT, botUserId: 'UBOT', installedBy: 'UOWNER2' },
  consent_undone: { type: 'consent_undone', at: AT },
  app_removed: { type: 'app_removed', at: AT },
  archive_with_token: { type: 'archive', at: AT, hasBotToken: true },
  archive_without_token: { type: 'archive', at: AT, hasBotToken: false },
  uninstalled: { type: 'uninstalled', at: AT },
  uninstall_refused: { type: 'uninstall_refused', at: AT },
  uninstall_unanswered: { type: 'uninstall_unanswered', at: AT, restore: states.active },
  uninstall_unanswered_other_app: { type: 'uninstall_unanswered', at: AT, restore: { ...states.active, app: { appId: 'A0OTHER', clientId: '9.9' } } },
  deleted: { type: 'deleted', at: AT },
  try_again: { type: 'try_again', at: AT, startedBy: 'UOWNER2', manifestFingerprint: 'f4' },
} satisfies Record<string, AgentAppEvent>;

/** Every allowed row of the lifecycle table, keyed `state -> event`, with the state it reaches. */
const allowed: Record<string, AgentAppTransition> = {
  'releasing_handle -> handle_released': { state: 'creating', at: AT, startedBy: 'UOWNER', manifestFingerprint: 'f2' },
  'releasing_handle -> handle_release_refused': { ...states.attention_handle, at: AT },
  'releasing_handle -> handle_permission_missing': { state: 'withdrawn' },
  'releasing_handle -> archive_with_token': { state: 'deleted' },
  'releasing_handle -> archive_without_token': { state: 'deleted' },
  'creating -> created': { state: 'created', at: AT, startedBy: 'UOWNER', app: APP },
  'creating -> create_refused': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'create_refused', resume: 'creating' },
  'creating -> create_busy': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'slack_busy', resume: 'creating' },
  'creating -> create_ambiguous': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'ambiguous_create', resume: 'creating' },
  'creating -> config_token_needed': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'config_token_needed', resume: 'creating' },
  'creating -> archive_with_token': { refused: 'create_settling' },
  'creating -> archive_without_token': { refused: 'create_settling' },
  'creating_stale -> created': { state: 'created', at: AT, startedBy: 'UOWNER', app: APP },
  'creating_stale -> create_refused': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'create_refused', resume: 'creating' },
  'creating_stale -> create_busy': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'slack_busy', resume: 'creating' },
  'creating_stale -> create_ambiguous': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'ambiguous_create', resume: 'creating' },
  'creating_stale -> config_token_needed': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'config_token_needed', resume: 'creating' },
  'creating_stale -> archive_with_token': { state: 'deleted' },
  'creating_stale -> archive_without_token': { state: 'deleted' },
  'created -> recreate': { state: 'creating', at: AT, startedBy: 'UOWNER', manifestFingerprint: 'f3' },
  'created -> urls_set': { state: 'urls_set', at: AT, startedBy: 'UOWNER', app: APP },
  'created -> urls_refused': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'urls_refused', resume: 'created', app: APP },
  'created -> config_token_needed': { state: 'needs_attention', at: AT, startedBy: 'UOWNER', reason: 'config_token_needed', resume: 'created', app: APP },
  'created -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'created -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'urls_set -> icon_set': { state: 'icon_set', at: AT, startedBy: 'UOWNER', app: APP, icon: 'default_avatar' },
  'urls_set -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'urls_set -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'icon_set -> allow_dm_posted': { ...states.awaiting_consent, at: AT },
  'icon_set -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'icon_set -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'awaiting_consent -> consent_opened': { ...states.awaiting_consent_opened, at: AT },
  'awaiting_consent -> consent_granted': {
    state: 'active', at: AT, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: AT, installedBy: 'UOWNER2',
  },
  'awaiting_consent -> consent_undone': { ...states.awaiting_consent, at: AT },
  'awaiting_consent -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'awaiting_consent -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'awaiting_consent_opened -> consent_opened': { ...states.awaiting_consent_opened, at: AT },
  'awaiting_consent_opened -> consent_granted': {
    state: 'active', at: AT, app: APP, icon: 'agent_avatar', botUserId: 'UBOT', installedAt: AT, installedBy: 'UOWNER2',
  },
  'awaiting_consent_opened -> consent_undone': { ...states.awaiting_consent, at: AT },
  'awaiting_consent_opened -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'awaiting_consent_opened -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'active -> app_removed': { ...states.attention_removed, at: AT, icon: 'agent_avatar' },
  'active -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'uninstall' },
  'active -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'delete' },
  'uninstalling_uninstall -> uninstalled': { ...states.uninstalling_uninstall, at: AT, next: 'delete' },
  'uninstalling_uninstall -> uninstall_refused': { ...states.attention_uninstall, at: AT },
  'uninstalling_uninstall -> uninstall_unanswered': states.active,
  'uninstalling_uninstall -> archive_with_token': states.uninstalling_uninstall,
  'uninstalling_uninstall -> archive_without_token': states.uninstalling_uninstall,
  'uninstalling_delete -> deleted': { state: 'deleted' },
  'uninstalling_delete -> archive_with_token': states.uninstalling_delete,
  'uninstalling_delete -> archive_without_token': states.uninstalling_delete,
  'attention_no_app -> try_again': { state: 'creating', at: AT, startedBy: 'UOWNER2', manifestFingerprint: 'f4' },
  'attention_no_app -> archive_with_token': { state: 'deleted' },
  'attention_no_app -> archive_without_token': { state: 'deleted' },
  'attention_handle -> try_again': { state: 'releasing_handle', at: AT, startedBy: 'UOWNER2' },
  'attention_handle -> archive_with_token': { state: 'deleted' },
  'attention_handle -> archive_without_token': { state: 'deleted' },
  'attention_created -> try_again': { state: 'created', at: AT, startedBy: 'UOWNER2', app: APP },
  'attention_created -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'attention_created -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'attention_removed -> try_again': { state: 'icon_set', at: AT, startedBy: 'UOWNER2', app: APP, icon: 'default_avatar' },
  'attention_removed -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'uninstall' },
  'attention_removed -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, next: 'delete' },
  'attention_uninstall -> try_again': { state: 'uninstalling', at: AT, startedBy: 'UOWNER2', app: APP, botUserId: 'UBOT', next: 'uninstall' },
  'attention_uninstall -> archive_with_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'uninstall' },
  'attention_uninstall -> archive_without_token': { state: 'uninstalling', at: AT, startedBy: 'UOWNER', app: APP, botUserId: 'UBOT', next: 'delete' },
};

test('every row of the lifecycle table transitions, and every other pair is refused', () => {
  const seen = new Set<string>();
  for (const [stateName, app] of Object.entries(states)) {
    for (const [eventName, event] of Object.entries(events)) {
      const key = `${stateName} -> ${eventName}`;
      const result = transition(app, event);
      const expected = allowed[key];
      if (expected) {
        seen.add(key);
        assert.deepEqual(result, expected, key);
      } else {
        assert.deepEqual(result, { refused: 'wrong_state' }, `${key} must be refused`);
      }
    }
  }
  assert.deepEqual([...Object.keys(allowed)].filter((key) => !seen.has(key)), [], 'every allowed row was exercised');
});

test('consent cannot be granted before the Allow message exists', () => {
  const result = transition(states.created, events.consent_granted);
  assert.equal(isRefusal(result), true);
  assert.deepEqual(result, { refused: 'wrong_state' });
});

test('a fresh create blocks archive until it settles, a stale one is let go without an app to delete', () => {
  assert.deepEqual(transition(states.creating, events.archive_without_token), { refused: 'create_settling' });
  assert.equal(createIsStale(states.creating, AT), false);
  assert.equal(createIsStale(states.creating_stale, AT), true);
  assert.deepEqual(transition(states.creating_stale, events.archive_without_token), { state: 'deleted' });
});

test('the next step names the one external effect due, and nothing while the record waits', () => {
  const now = AT;
  assert.equal(nextStep(initialAgentApp('UOWNER', T0), now), 'release_handle');
  assert.equal(nextStep(states.creating, now), 'create');
  assert.equal(nextStep(states.creating_stale, now), undefined);
  assert.equal(nextStep(states.created, now), 'set_urls');
  assert.equal(nextStep(states.urls_set, now), 'set_icon');
  assert.equal(nextStep(states.icon_set, now), 'post_allow_dm');
  assert.equal(nextStep(states.awaiting_consent, now), undefined);
  assert.equal(nextStep(states.active, now), undefined);
  assert.equal(nextStep(states.uninstalling_uninstall, now), 'uninstall');
  assert.equal(nextStep(states.uninstalling_delete, now), 'delete');
  assert.equal(nextStep(states.attention_created, now), undefined);
});

test('a resume that needs an app the record lacks is refused rather than invented', () => {
  const noApp: AgentAppLifecycle = { state: 'needs_attention', at: T0, startedBy: 'UOWNER', reason: 'urls_refused', resume: 'created' };
  assert.deepEqual(transition(noApp, events.try_again), { refused: 'wrong_state' });
});
