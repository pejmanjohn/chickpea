import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ts from 'typescript';

import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { AGENT_MENTION, delivery, message, withLane, type Lane } from './helpers/gateway-admission-lane.ts';

/** The admission reads the gateway answered, by kind. */
function reads(calls: string[]): { users: number; conversations: number } {
  return {
    users: calls.filter((operation) => operation === 'users.info').length,
    conversations: calls.filter((operation) => operation === 'conversations.info').length,
  };
}

/** The visibility a turn's Run was admitted with: whether its content counts as public or private. */
function admittedVisibility(lane: Lane, job: TurnJob | undefined): string | undefined {
  assert.ok(job, 'the message became a turn');
  return lane.visibility.get(job.id);
}

// Slack's user_change is documented as sent when "a member updates their
// profile or data"; nothing says it fires for deactivation, guest status,
// the bot flag or Slack Connect status, and no subscribed event announces a
// Channel turning private or shared. So these facts are read from Slack on
// every admission.
//
// Defects caught: an earlier answer reused for a Channel's Slack Connect
// sharing, for its visibility, or for a person's guest status (each a cache
// anywhere on the drain's admission path), and a state store that hands the
// drain a store of earlier answers.
test("every admission reads a Channel's sharing and visibility, and a person's standing, from Slack", async () => {
  await withLane(async (lane) => {
    const { jobs, calls, channel, people, admit } = lane;
    let ts = 100;
    const reply = () => {
      ts += 1;
      return delivery(message({ ts: `5000.000${ts}`, thread_ts: '5000.000100', text: 'one more thing' }));
    };

    await admit(delivery(AGENT_MENTION));
    assert.deepEqual(reads(calls), { users: 1, conversations: 1 });
    assert.equal(jobs[0]?.turn.sharedChannel, false);
    assert.equal(admittedVisibility(lane, jobs[0]), 'public');

    // Moments later the Channel is shared with another organization.
    channel.is_ext_shared = true;
    await admit(reply());
    assert.deepEqual(reads(calls), { users: 2, conversations: 2 });
    assert.equal(jobs[1]?.turn.sharedChannel, true, 'a run review would never copy this turn');

    // Then it is made private.
    channel.is_private = true;
    await admit(reply());
    assert.deepEqual(reads(calls), { users: 3, conversations: 3 });
    assert.equal(jobs.length, 3);
    assert.equal(admittedVisibility(lane, jobs[2]), 'private', 'its content is never shown as public-sourced');

    // Then the person becomes a guest.
    people.set('U1', { is_restricted: true });
    await admit(reply());
    assert.deepEqual(reads(calls), { users: 4, conversations: 4 });
    assert.equal(jobs.length, 3, "a guest's message is not admitted on a member's earlier answer");
  });

  // The state store hands its inbox drain no Slack answers of its own: the
  // stores, the env and the hand-off callback, as above.
  const source = ts.createSourceFile(
    'cloudflare.ts',
    readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const drain = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'drainGatewayInbox');
  assert.deepEqual(drain?.parameters.map((parameter) => parameter.name.getText(source)), ['stores', 'platformEnv', 'onAdmitted']);
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'drainGatewayInbox') calls.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(calls, ['drainGatewayInbox(stores, this.env as PlatformEnv, onAdmitted)']);
});
