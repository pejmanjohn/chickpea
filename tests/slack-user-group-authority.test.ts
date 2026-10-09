import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { SLACK_USER_GROUP_SCOPES } from '../src/slack/scopes.ts';
import { withUserGroupAuthority } from '../src/slack/user-group-authority.ts';

const OWNER = 'xoxp-w16-owner-secret';
const BOT = 'xoxb-w16-bot-secret';
const CALLER_REFUSALS = [
  'token_revoked', 'invalid_auth', 'not_authed', 'token_expired', 'account_inactive', 'missing_scope',
  'permission_denied', 'not_allowed', 'restricted_action', 'two_factor_setup_required', 'two_factor_required',
];

function slack(answers: Record<string, string>) {
  const calls: string[] = [];
  const log: Array<Record<string, unknown>> = [];
  const levels: string[] = [];
  return {
    calls,
    log,
    levels,
    run: (owner: string | undefined) => withUserGroupAuthority({
      operation: 'usergroups.disable',
      owner,
      bot: BOT,
      call: async (token: string) => {
        calls.push(token);
        return answers[token]!;
      },
      errorCode: (code) => code === 'ok' ? undefined : code,
      log: (entry, level) => { log.push(entry); levels.push(level); },
    }),
  };
}

function assertNoToken(text: string): void {
  assert.equal(text.includes(OWNER), false, 'the Owner token never appears');
  assert.equal(text.includes(BOT), false, 'the bot token never appears');
}

test('a hosted install asks the installing Owner for exactly the user-group scopes', () => {
  assert.deepEqual(SLACK_USER_GROUP_SCOPES, ['usergroups:read', 'usergroups:write']);
  assert.ok(Object.isFrozen(SLACK_USER_GROUP_SCOPES));
});

test('without an Owner token a user-group call is the bot\'s alone and logs nothing', async () => {
  const denied = slack({ [BOT]: 'permission_denied' });
  assert.deepEqual(await denied.run(undefined), { outcome: 'permission_denied', answeredBy: 'bot' });
  assert.deepEqual(denied.calls, [BOT]);
  assert.deepEqual(denied.log, []);
});

test('an Owner token answers user-group calls and the bot is never asked', async () => {
  const ok = slack({ [OWNER]: 'ok', [BOT]: 'ok' });
  assert.deepEqual(await ok.run(OWNER), { outcome: 'ok', answeredBy: 'owner' });
  assert.deepEqual(ok.calls, [OWNER]);
  assert.deepEqual(ok.log, [
    { event: 'chickpea.slack_user_groups.call', operation: 'usergroups.disable', answeredBy: 'owner', code: 'ok' },
  ]);
  assert.deepEqual(ok.levels, ['info'], 'an Owner\'s success is information, not a warning');
});

test('each refusal of the Owner as caller asks the bot exactly once, and the bot\'s answer stands', async () => {
  for (const ownerCode of CALLER_REFUSALS) {
    for (const botCode of ['ok', 'permission_denied']) {
      const fallback = slack({ [OWNER]: ownerCode, [BOT]: botCode });
      assert.deepEqual(await fallback.run(OWNER), { outcome: botCode, answeredBy: 'bot' }, `${ownerCode} -> ${botCode}`);
      assert.deepEqual(fallback.calls, [OWNER, BOT], ownerCode);
      assert.deepEqual(fallback.log, [{
        event: 'chickpea.slack_user_groups.call', operation: 'usergroups.disable',
        answeredBy: 'bot', code: botCode, ownerCode,
      }], ownerCode);
      assert.deepEqual(fallback.levels, ['warn'], ownerCode);
      assertNoToken(JSON.stringify(fallback.log));
    }
  }
});

test('a rate limit, an unreachable Slack, or a refusal of the request itself never reaches the bot', async () => {
  for (const code of ['ratelimited', 'slack_unreachable', 'slack_webapi_request_error', 'no_such_subteam',
    'already_disabled', 'name_already_exists', 'paid_teams_only', 'invalid_response']) {
    const kept = slack({ [OWNER]: code, [BOT]: 'ok' });
    assert.deepEqual(await kept.run(OWNER), { outcome: code, answeredBy: 'owner' }, code);
    assert.deepEqual(kept.calls, [OWNER], code);
    assert.deepEqual(kept.log, [
      { event: 'chickpea.slack_user_groups.call', operation: 'usergroups.disable', answeredBy: 'owner', code },
    ], code);
    assert.deepEqual(kept.levels, ['warn'], code);
  }
});

test('by default a fallback goes to console.warn and an Owner\'s success to console.info, as JSON without any token', async (t: TestContext) => {
  const lines: string[] = [];
  const infos: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  t.mock.method(console, 'info', (...args: unknown[]) => { infos.push(args.map(String).join(' ')); });
  const result = await withUserGroupAuthority({
    operation: 'usergroups.enable',
    owner: OWNER,
    bot: BOT,
    call: async (token: string) => token === OWNER ? 'token_revoked' : 'ok',
    errorCode: (code) => code === 'ok' ? undefined : code,
  });
  assert.equal(result.answeredBy, 'bot');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: 'chickpea.slack_user_groups.call', operation: 'usergroups.enable',
    answeredBy: 'bot', code: 'ok', ownerCode: 'token_revoked',
  });
  assert.deepEqual(infos, []);

  const owned = await withUserGroupAuthority({
    operation: 'usergroups.list',
    owner: OWNER,
    bot: BOT,
    call: async () => 'ok',
    errorCode: (code) => code === 'ok' ? undefined : code,
  });
  assert.equal(owned.answeredBy, 'owner');
  assert.equal(lines.length, 1, 'a success adds no warning');
  assert.deepEqual(infos.map((line) => JSON.parse(line)), [
    { event: 'chickpea.slack_user_groups.call', operation: 'usergroups.list', answeredBy: 'owner', code: 'ok' },
  ]);
  assertNoToken([...lines, ...infos].join('\n'));
});
