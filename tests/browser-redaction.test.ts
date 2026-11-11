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
});

test('a value of only whitespace adds no secret', () => {
  const typed = secrets('   ', '');
  assert.equal(typed.redact(' '), ' ');
  assert.equal(typed.redact('a  b'), 'a  b');
});
