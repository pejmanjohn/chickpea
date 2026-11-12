import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeWebsiteLoginHost } from '../src/browser/logins.ts';
import { browserHandoffMessage } from '../src/browser/requester.ts';
import { htmlNamedReference } from '../src/review/html-references.ts';
import { buildRunReviewRecord, runReviewPseudonymizer, type RunReviewInput, type RunReviewRecordV1 } from '../src/review/record.ts';
import type { RunReviewWebsiteLogins } from '../src/review/website-logins.ts';
import { toContextMessage } from '../src/slack/thread-context.ts';
import { PRODUCERS, type Producer } from './helpers/encoders.ts';

const LOGINS: RunReviewWebsiteLogins = {
  // A site saved with `www.`, which a browser's address bar hides.
  hosts: ['billing.example.com', normalizeWebsiteLoginHost('bücher.example'), 'www.ledger.example.org'],
  usernames: ['Müller.Synthuser@example.com', 'Jörg.O\'Brien+synthops@example.com'],
};

type Field = 'prose' | 'browser step';

interface Credential {
  name: string;
  text: string;
  /** Parts of the credential no producer changes, so a copy that holds none holds the credential in no form. */
  secrets: readonly string[];
  fields: readonly Field[];
}

const EVERY_FIELD: readonly Field[] = ['prose', 'browser step'];
const HANDOFF_URL = 'https://live.provider.example/s/SynthLive53?view=full&t=SynthLive54';

/** `address` with a user and a password, as the URL standard's setters write them. */
function withUserinfo(address: string, user: string, password: string): string {
  const url = new URL(address);
  url.username = user;
  url.password = password;
  return url.href;
}

/**
 * Each kind of credential a copy could see. A typed password or one-time
 * code reaches a copy only in an address, as a form sent by GET or a
 * verification link writes it: a page that shows one is redacted where the
 * browser reads it (src/browser), before any step is recorded.
 */
const CREDENTIALS: readonly Credential[] = [
  { name: 'saved username', text: 'Müller.Synthuser@example.com', secrets: ['synthuser'], fields: EVERY_FIELD },
  { name: 'saved username with marks', text: 'Jörg.O\'Brien+synthops@example.com', secrets: ['synthops'], fields: EVERY_FIELD },
  {
    name: 'typed password in a form\'s address',
    text: 'https://billing.example.com/session?user=ops&password=SynthPass4417%21',
    secrets: ['SynthPass4417'],
    fields: EVERY_FIELD,
  },
  { name: 'one-time code in a query', text: 'https://billing.example.com/verify?otp=830417&remember=1', secrets: ['830417'], fields: EVERY_FIELD },
  { name: 'one-time code in a path', text: 'https://billing.example.com/verify/830418/confirm', secrets: ['830418'], fields: EVERY_FIELD },
  {
    name: 'Browserbase live view',
    text: 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/SynthSess41/devtools/page/SynthPage42&debug=true',
    secrets: ['SynthSess41', 'SynthPage42', 'browserbase'],
    fields: EVERY_FIELD,
  },
  {
    name: 'Browserbase session link',
    text: 'https://www.browserbase.com/sessions/SynthSess43',
    secrets: ['SynthSess43', 'browserbase'],
    fields: EVERY_FIELD,
  },
  {
    name: 'hand-off message',
    text: browserHandoffMessage('portal.example.com', 'https://live.provider.example/s/SynthLive51?view=full&t=SynthLive52'),
    secrets: ['SynthLive51', 'SynthLive52'],
    fields: EVERY_FIELD,
  },
  {
    name: 'hand-off message in a later turn\'s context row',
    text: toContextMessage({
      ts: '1792915200.000100', user: 'U0BOT12345', text: browserHandoffMessage('portal.example.com', HANDOFF_URL),
      blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: HANDOFF_URL, text: 'Open the browser' }] }] }],
    }, { botUserId: 'U0BOT12345' })!.text,
    secrets: ['SynthLive53', 'SynthLive54'],
    fields: EVERY_FIELD,
  },
  {
    name: 'sign-in token in a login site\'s query',
    text: 'https://billing.example.com/callback?code=SynthCode61&state=SynthState62',
    secrets: ['SynthCode61', 'SynthState62'],
    fields: EVERY_FIELD,
  },
  {
    name: 'sign-in token in a login site\'s fragment',
    text: 'https://billing.example.com/callback#access_token=SynthToken63&token_type=bearer',
    secrets: ['SynthToken63'],
    fields: EVERY_FIELD,
  },
  { name: 'sign-in token in a login site\'s path', text: 'https://billing.example.com/magic/SynthPath64/done', secrets: ['SynthPath64'], fields: EVERY_FIELD },
  { name: 'sign-in token on an IDN login site', text: 'https://bücher.example/callback?code=SynthIdn65', secrets: ['SynthIdn65'], fields: EVERY_FIELD },
  {
    name: 'sign-in token on a login site saved with www.',
    text: 'https://www.ledger.example.org/callback?code=SynthWww66',
    secrets: ['SynthWww66'],
    fields: EVERY_FIELD,
  },
  // A site builds a segment from a bearer with encodeURIComponent, which writes its `/` as `%2F`: one segment, two words.
  {
    name: 'sign-in bearer with a slash in a login site\'s path segment',
    text: `https://billing.example.com/magic/${encodeURIComponent('SynthAlpha/SynthBravo')}/done`,
    secrets: ['SynthAlpha', 'SynthBravo'],
    fields: EVERY_FIELD,
  },
  {
    name: 'sign-in bearer with a slash in a path segment on a login site saved with www.',
    text: `https://www.ledger.example.org/magic/${encodeURIComponent('SynthCharlie/SynthDelta')}/done`,
    secrets: ['SynthCharlie', 'SynthDelta'],
    fields: EVERY_FIELD,
  },
  // The setters write each `/`, `?`, `#`, `@` and `:` of a user or a password as its escape: the userinfo's data,
  // which hides neither the login site nor its token, and goes whole.
  {
    name: 'password and token behind a userinfo that holds delimiters',
    text: withUserinfo('https://billing.example.com/callback?code=SynthUserinfo81', 'SynthOps/SynthTeam', 'SynthPass/?#@:4417'),
    secrets: ['SynthOps', 'SynthTeam', 'SynthPass', 'SynthUserinfo81'],
    fields: EVERY_FIELD,
  },
  {
    name: 'password in another site\'s userinfo that holds delimiters',
    text: withUserinfo('https://accounts.other.example/inbox?q=kept', 'SynthCrew?SynthMate', 'SynthWord#4418'),
    secrets: ['SynthCrew', 'SynthMate', 'SynthWord'],
    fields: EVERY_FIELD,
  },
  {
    name: 'sign-in token in a browser step\'s query',
    text: 'https://accounts.other.example/oauth/callback?code=SynthCode71',
    secrets: ['SynthCode71'],
    fields: ['browser step'],
  },
  {
    name: 'sign-in token in a browser step\'s fragment',
    text: 'https://accounts.other.example/done#id_token=SynthToken72',
    secrets: ['SynthToken72'],
    fields: ['browser step'],
  },
  {
    name: 'sign-in token in a browser step\'s path',
    text: 'https://accounts.other.example/magic/SynthPath73/done',
    secrets: ['SynthPath73'],
    fields: ['browser step'],
  },
  {
    name: 'sign-in bearer with a slash in a browser step\'s path segment',
    text: `https://accounts.other.example/magic/${encodeURIComponent('SynthEcho/SynthFoxtrot')}/done`,
    secrets: ['SynthEcho', 'SynthFoxtrot'],
    fields: ['browser step'],
  },
];

/**
 * Cells that cannot pass without breaking the coordinator's criterion,
 * each with its reason. Empty: every realistic encoding, and every pair of
 * them, leaves no credential.
 */
const ACCEPTED: ReadonlyMap<string, string> = new Map();

function record(field: Field, text: string): RunReviewRecordV1 {
  const input: RunReviewInput = {
    runId: 'run_matrix',
    recordedAt: '2026-11-11T12:00:00.000Z',
    surface: 'dm',
    agentId: 'agent_matrix',
    trigger: { author: 'U012ABCDEF3', text: 'Check the invoice.', files: [] },
    context: [],
    steps: field === 'browser step' ? [{ kind: 'tool', name: 'browser_snapshot', input: '{}', output: `Page: ${text} end` }] : [],
    answer: field === 'prose' ? `Here: ${text} end` : 'Done.',
    outcome: 'succeeded',
    timings: { settledAt: '2026-11-11T12:00:01.000Z' },
    truncated: false,
    source: 'stream',
    websiteLogins: LOGINS,
    browserStepsWithheld: false,
  };
  return buildRunReviewRecord(input, runReviewPseudonymizer(new Uint8Array(32).fill(7)));
}

/** Every way the matrix writes a credential: as itself, by each producer, and by each producer of another's output. */
function encodings(text: string): Array<{ path: string; text: string }> {
  const out = [{ path: 'as written', text }];
  const once = PRODUCERS.flatMap((producer) => applied(producer, text, producer.name));
  out.push(...once);
  for (const inner of once) {
    for (const outer of PRODUCERS) out.push(...applied(outer, inner.text, `${inner.path} → ${outer.name}`));
  }
  return out;
}

function applied(producer: Producer, text: string, path: string): Array<{ path: string; text: string }> {
  const encoded = producer.encode(text);
  return encoded === undefined ? [] : [{ path, text: encoded }];
}

test('every realistic encoding of a credential, and every pair of them nested, leaves no part of it in a copy', (t) => {
  const failed = new Map<string, string>();
  let cells = 0;
  for (const credential of CREDENTIALS) {
    for (const { path, text } of encodings(credential.text)) {
      const lower = text.toLowerCase();
      assert.ok(credential.secrets.every((secret) => lower.includes(secret.toLowerCase())), `${path} keeps ${credential.name}'s secrets as written`);
      for (const field of credential.fields) {
        cells += 1;
        const copied = JSON.stringify(record(field, text)).toLowerCase();
        const kept = credential.secrets.filter((secret) => copied.includes(secret.toLowerCase()));
        if (kept.length) failed.set(`${credential.name} | ${path} | ${field}`, kept.join(', '));
      }
    }
  }
  t.diagnostic(`${cells} cells: ${PRODUCERS.length} producers, alone and in ${PRODUCERS.length ** 2} nested pairs, ` +
    `${CREDENTIALS.length} credentials; ${cells - failed.size} pass`);
  assert.deepEqual([...failed.keys()].filter((cell) => !ACCEPTED.has(cell)), [], [...failed].slice(0, 20).map(String).join('\n'));
  assert.deepEqual([...ACCEPTED.keys()].filter((cell) => !failed.has(cell)), [], 'every accepted cell still fails');
});

test('the HTML table names each character reference as HTML does, and nothing an object inherits', () => {
  assert.equal(htmlNamedReference('uuml'), 'ü');
  assert.equal(htmlNamedReference('Uuml'), 'Ü');
  assert.equal(htmlNamedReference('amp'), '&');
  assert.equal(htmlNamedReference('NewLine'), '\n');
  assert.equal(htmlNamedReference('semi'), ';');
  assert.equal(htmlNamedReference('fjlig'), 'fj');
  assert.equal(htmlNamedReference('NotEqualTilde'), String.fromCodePoint(0x2242, 0x338));
  assert.equal(htmlNamedReference('CounterClockwiseContourIntegral'), String.fromCodePoint(0x2233));
  assert.equal(htmlNamedReference('Afr'), String.fromCodePoint(0x1d504));
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'uuml;', 'UUML', '']) {
    assert.equal(htmlNamedReference(name), undefined, name);
  }
});
