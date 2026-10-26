import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  configureHostPageScript,
  hostPageScriptConfigured,
  hostPageScriptTag,
} from '../src/admin/host-script.ts';
import { renderAdminPage, renderSlackJourneyPage, renderSlackSignInPage } from '../src/admin/page.ts';

const journey = () => renderSlackJourneyPage({ surface: 'test', eyebrow: 'Chickpea', title: 'Hello', body: '<p>Body</p>' });
const head = (html: string) => html.slice(0, html.indexOf('</head>'));
const shells = { admin: () => renderAdminPage(), journey, signIn: () => renderSlackSignInPage('/admin') };

afterEach(() => configureHostPageScript(undefined));

test('without a host script, no shell carries a script in its head', () => {
  assert.equal(hostPageScriptConfigured(), false);
  assert.equal(hostPageScriptTag(), '');
  for (const [name, render] of Object.entries(shells)) {
    assert.doesNotMatch(head(render()), /<script/, name);
  }
});

test('a host script goes in the head of every shell, once', () => {
  configureHostPageScript('/_host/page.js');
  assert.equal(hostPageScriptConfigured(), true);
  for (const [name, render] of Object.entries(shells)) {
    const html = render();
    assert.deepEqual(head(html).match(/<script[^>]*>/g), ['<script src="/_host/page.js" defer>'], name);
    assert.equal(html.split('/_host/page.js').length, 2, name);
  }
});

test('removing the host script renders every shell as it was before one was installed', () => {
  const before = Object.values(shells).map((render) => render());
  configureHostPageScript('/_host/page.js');
  configureHostPageScript(undefined);
  assert.equal(hostPageScriptConfigured(), false);
  assert.deepEqual(Object.values(shells).map((render) => render()), before);
});

test('only a same-origin path is accepted, and a refusal keeps the installed script', () => {
  configureHostPageScript('/_host/page.js');
  for (const path of [
    'https://cdn.example/x.js',
    '//cdn.example/x.js',
    '/\\cdn.example/x.js',
    'javascript:alert(1)',
    '/x.js" onload="alert(1)',
    "/x.js'",
    '/x.js?v=1',
    '/x.js#a',
    '/x .js',
    '/x<.js',
    'x.js',
    '',
    `/${'a'.repeat(256)}`,
  ]) {
    assert.throws(() => configureHostPageScript(path), /same-origin path/, path);
  }
  assert.equal(hostPageScriptTag(), '<script src="/_host/page.js" defer></script>');
});
