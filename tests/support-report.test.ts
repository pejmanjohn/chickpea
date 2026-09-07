import assert from 'node:assert/strict';
import test from 'node:test';
import { supportReport } from '../src/release/support-report.ts';

test('support report projects closed fields and never includes arbitrary private values', () => {
  const report = supportReport({
    identity: { version: '0.1.0', sourceCommit: 'a'.repeat(40) }, deployment: 'cloudflare',
    setup: 'ready', providers: { anthropic: 'configured', openai: 'missing', openrouter: 'missing', 'workers-ai': 'configured' },
    errors: ['provider-status-unavailable', 'https://private.test/?token=secret'],
    private: 'Slack transcript xoxb-private-secret',
  } as Parameters<typeof supportReport>[0]);
  assert.match(report, /anthropic: configured \(not verified\)/);
  assert.match(report, /CLI version: not applicable/);
  assert.match(report, /provider-status-unavailable/);
  assert.doesNotMatch(report, /private|secret|transcript/);
});
