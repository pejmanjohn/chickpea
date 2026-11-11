import assert from 'node:assert/strict';
import test from 'node:test';
import { TypedSecrets } from '../src/browser/redaction.ts';

function secrets(...values: string[]): TypedSecrets {
  const typed = new TypedSecrets();
  for (const value of values) typed.add(value);
  return typed;
}

test('a secret is replaced as typed, collapsed, rewrapped and escaped, and nothing else changes', () => {
  const typed = secrets('Synth"etic\\Pass  0042');
  assert.equal(typed.redact('a Synth"etic\\Pass  0042 b'), 'a [redacted] b');
  assert.equal(typed.redact('a Synth"etic\\Pass 0042 b'), 'a [redacted] b');
  assert.equal(typed.redact('a Synth"etic\\Pass\n0042 b'), 'a [redacted] b');
  assert.equal(typed.redact('value="Synth\\"etic\\\\Pass 0042"'), 'value="[redacted]"');
  assert.equal(typed.redact('Synthetic Pass 0042'), 'Synthetic Pass 0042');
});

test('a secret is replaced where text shows it URL-encoded, as a link, a title or an error that names an address does', () => {
  const typed = secrets('Synth"etic\\Pass  0042');
  assert.equal(typed.redact('link "/next?p=Synth%22etic%5CPass%20%200042"'), 'link "/next?p=[redacted]"');
  assert.equal(typed.redact('Cannot open /reset/Synth%22etic%5cPass++0042/confirm now'), 'Cannot open /reset/[redacted]/confirm now');
  assert.equal(typed.redact('Synth%22etic%5CPass%20%20042'), 'Synth%22etic%5CPass%20%20042');
  // Form-encoded with nothing but `+` for its spaces.
  assert.equal(secrets('Synthetic Pass 0042').redact('No results for q=Synthetic+Pass+0042'), 'No results for q=[redacted]');
});

test('a secret under 4 characters is replaced only where it is a whole field', () => {
  const typed = secrets('Q7!');
  assert.equal(typed.redact('Q7!'), '[redacted]');
  assert.equal(typed.redact('  Q7!\n'), '[redacted]');
  assert.equal(typed.redact('Q7!!'), 'Q7!!');
  assert.equal(typed.redact('Press Q7! to continue'), 'Press Q7! to continue');
});

test('the start of a secret left before an ellipsis is replaced', () => {
  const typed = secrets('aabaaab-Synthetic-Passphrase');
  assert.equal(typed.redact('"Your phrase is aabaaab-Synth…"'), '"Your phrase is [redacted]…"');
  // The longest prefix that ends at the ellipsis, even when an earlier partial match overlaps it.
  assert.equal(typed.redact('aabaabaaab-Syn…'), 'aab[redacted]…');
  assert.equal(typed.redact('aabaaabaaab-Syn…'), 'aaba[redacted]…');
  assert.equal(typed.redact('aabaaab-Syn and more'), 'aabaaab-Syn and more');
  assert.equal(typed.redact('see aab…'), 'see aab…');
  assert.equal(secrets('Synth"etic-Passphrase').redact('value="Synth\\"etic-Pa…"'), 'value="[redacted]…"');
});

test('a secret that contains another is replaced whole', () => {
  const typed = secrets('482913', 'Synthetic-482913-Pass');
  assert.equal(typed.redact('Synthetic-482913-Pass then 482913'), '[redacted] then [redacted]');
  // Where two secrets start at the same place, the longer one is tried first.
  assert.equal(
    secrets('Synthetic-Pass', 'Synthetic-Pass-0042').redact('Synthetic-Pass-0042 then Synthetic-Pass'),
    '[redacted] then [redacted]',
  );
});

test('a URL loses a secret that is percent- or form-encoded, or a whole short value', () => {
  assert.equal(
    secrets('P@ss w0rd!#&=').redactUrl('https://site.example/session?login=ops%40example.com&password=P%40ss+w0rd%21%23%26%3D#done'),
    'https://site.example/session?login=ops%40example.com&password=[redacted]#done',
  );
  assert.equal(
    secrets('Synth"etic Pass').redactUrl('https://site.example/reset/Synth%22etic%20Pass/confirm'),
    'https://site.example/reset/[redacted]/confirm',
  );
  assert.equal(secrets('Q7!').redactUrl('https://site.example/s?p=Q7%21&q=Q7%21x'), 'https://site.example/s?p=[redacted]&q=Q7%21x');
  assert.equal(secrets('Q7!').redactUrl('https://site.example/s?p=%E0%A4%A&q=1'), 'https://site.example/s?p=%E0%A4%A&q=1');
  // A `+` may stand for a space or for itself.
  assert.equal(secrets('Q 7').redactUrl('https://site.example/s?p=Q+7&q=Q%207'), 'https://site.example/s?p=[redacted]&q=[redacted]');
  assert.equal(secrets('Q+7').redactUrl('https://site.example/s?p=Q+7&q=Q%2B7&r=Q+7x'), 'https://site.example/s?p=[redacted]&q=[redacted]&r=Q+7x');
});

test('a URL loses a secret a script joined into it, where some characters are encoded and others are not', () => {
  // As `location.href = '/s?p=' + password` leaves it: the browser encodes the space and keeps the `@`.
  assert.equal(
    secrets('P@ss w0rd').redactUrl('https://site.example/s?user=ops@example.com&p=P@ss%20w0rd#p=P@ss%20w0rd'),
    'https://site.example/s?user=ops@example.com&p=[redacted]#p=[redacted]',
  );
  // As encodeURI leaves it, in either hex case.
  assert.equal(
    secrets('P@ss^w0rd').redactUrl('https://site.example/s?p=P@ss%5Ew0rd&q=P@ss%5ew0rd'),
    'https://site.example/s?p=[redacted]&q=[redacted]',
  );
  // A space the address keeps as it is, beside encoded and unencoded characters.
  assert.equal(secrets('P@ss w0rd^1').redactUrl('about:blank#P@ss w0rd%5E1'), 'about:blank#[redacted]');
  // Nothing encoded, across the characters a URL part ends at.
  assert.equal(secrets('P@ss:w0rd/1').redactUrl('https://site.example/s?p=P@ss:w0rd/1&q=1'), 'https://site.example/s?p=[redacted]&q=1');
  // Only the secret goes; the rest of the value stays.
  assert.equal(
    secrets('P@ss w0rd').redactUrl('https://site.example/s?q=before+P%40ss+w0rd+after'),
    'https://site.example/s?q=before+[redacted]+after',
  );
  assert.equal(secrets('P@ss w0rd').redactUrl('https://site.example/s?q=P%40ss-w0rd'), 'https://site.example/s?q=P%40ss-w0rd');
  // A `%` at the end of a secret is encoded as `%25`, which starts with the `%` itself.
  assert.equal(secrets('Pass100%').redactUrl('https://site.example/s?p=Pass100%25&q=1'), 'https://site.example/s?p=[redacted]&q=1');
  // JSON in a query value: the secret is escaped, then encoded, here with the backslashes left as they are.
  assert.equal(
    secrets('Synth"etic\\Pass').redactUrl('https://site.example/cb?state=%7B%22p%22%3A%22Synth\\%22etic\\\\Pass%22%7D&user=ops@example.com'),
    'https://site.example/cb?state=%7B%22p%22%3A%22[redacted]%22%7D&user=ops@example.com',
  );
  // An encoded no-break space and tab, beside an `@` left as it is.
  assert.equal(
    secrets('P@ss w0rd\t0042').redactUrl('https://site.example/s?p=P@ss%C2%A0w0rd%090042'),
    'https://site.example/s?p=[redacted]',
  );
  // Any other whitespace is found once its part is decoded.
  assert.equal(
    secrets('Synthetic Pass').redactUrl('https://site.example/s?p=Synthetic%E2%80%83Pass&q=1'),
    'https://site.example/s?p=[redacted]&q=1',
  );
  assert.equal(secrets('Synthetic  Pass').redactUrl('data:text/plain,Synthetic Pass'), 'data:text/plain,[redacted]');
  // Where two secrets start at the same place, the longer one is tried first.
  assert.equal(
    secrets('Synthetic-Pass', 'Synthetic-Pass-0042').redactUrl('https://site.example/s?p=Synthetic-Pass-0042'),
    'https://site.example/s?p=[redacted]',
  );
});

test('a secret is replaced where page text escapes it for JSON or HTML', () => {
  const typed = secrets('Synth/"é<Pass>&\'42');
  // PHP's JSON escapes the slash; Python's escapes every character outside ASCII.
  assert.equal(typed.redact('{"p":"Synth\\/\\"\\u00e9<Pass>&\'42"}'), '{"p":"[redacted]"}');
  assert.equal(typed.redact('{"p":"Synth/\\"\\u00E9<Pass>&\'42"}'), '{"p":"[redacted]"}');
  assert.equal(typed.redact('<input value="Synth/&quot;é&lt;Pass&gt;&amp;&#39;42">'), '<input value="[redacted]">');
  assert.equal(typed.redact('value="Synth/&#34;&#xE9;&#60;Pass&#x3e;&#038;&apos;42"'), 'value="[redacted]"');
  assert.equal(secrets('Synthetic Pass').redact('Synthetic&nbsp;Pass'), '[redacted]');
});

test('a secret of 8 characters or more is replaced in another letter case, and a shorter one only as typed', () => {
  assert.equal(secrets('Synthetic-Pass-1234').redact('YOU TYPED SYNTHETIC-PASS-1234'), 'YOU TYPED [redacted]');
  assert.equal(secrets('Synthetic-Pass-1234').redact('synthetic-pass-1234'), '[redacted]');
  assert.equal(secrets('Summer26').redact('summer26 sale'), '[redacted] sale');
  // Under 8, another case would erase ordinary words: `Ops1` would take every `OPS1` part number.
  assert.equal(secrets('Ops1').redact('Part OPS1 and Ops1'), 'Part OPS1 and [redacted]');
});

test('a secret typed with surrounding whitespace is replaced where the page trims it', () => {
  assert.equal(secrets('  Synthetic-Pass-1234 \n').redact('Wrong password: Synthetic-Pass-1234.'), 'Wrong password: [redacted].');
});

test('a code of 6 digits or more is replaced with its digits grouped, and only such a code', () => {
  const typed = secrets('482913');
  assert.equal(typed.redact('Code: 482 913'), 'Code: [redacted]');
  assert.equal(typed.redact('Code: 482-913 or 48.29.13'), 'Code: [redacted] or [redacted]');
  assert.equal(typed.redactUrl('https://site.example/verify?code=482+913'), 'https://site.example/verify?code=[redacted]');
  assert.equal(typed.redact('Code: 482  913'), 'Code: 482  913');
  assert.equal(secrets('Synth-1234').redact('Synth 1234'), 'Synth 1234');
});

test('a secret is replaced in either Unicode normalization form', () => {
  const composed = 'Synth\u00e9-Pass';
  const decomposed = 'Synthe\u0301-Pass';
  assert.equal(secrets(composed).redact(`Wrong password: ${decomposed}`), 'Wrong password: [redacted]');
  assert.equal(secrets(decomposed).redact(`Wrong password: ${composed}`), 'Wrong password: [redacted]');
});

test('the start of a secret left before three dots is replaced', () => {
  const typed = secrets('Synthetic-Passphrase-0042');
  assert.equal(typed.redact('Your phrase: Synthetic-Pa...'), 'Your phrase: [redacted]...');
  assert.equal(typed.redact('Synthetic-Pa.. and more'), 'Synthetic-Pa.. and more');
  assert.equal(typed.redact('Syn...'), 'Syn...');
});

test('mask draws a typed secret as bullets of one length, and shows tells whether text holds one', () => {
  const typed = secrets('Synthetic-Pass-1234', 'Q7!');
  assert.equal(typed.mask('Wrong password: Synthetic-Pass-1234'), 'Wrong password: ••••••••');
  assert.equal(typed.mask('Q7!'), '••••••••');
  assert.equal(typed.shows('Wrong password: synthetic-pass-1234'), true);
  assert.equal(typed.shows('Wrong password'), false);
  assert.equal(new TypedSecrets().empty, true);
  assert.equal(typed.empty, false);
});

test('a value of only whitespace adds no secret', () => {
  const typed = secrets('   ', '');
  assert.equal(typed.redact(' '), ' ');
  assert.equal(typed.redact('a  b'), 'a  b');
});
