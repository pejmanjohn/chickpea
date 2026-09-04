import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRST_TEAMMATE_STARTERS, firstTeammateInstruction } from '../src/management/first-teammate.ts';

test('first-teammate starters are DM-first, connection-free, and unique', () => {
  assert.ok(FIRST_TEAMMATE_STARTERS.length >= 3);
  const handles = FIRST_TEAMMATE_STARTERS.map(({ handle }) => handle);
  assert.equal(new Set(handles).size, handles.length);
  for (const starter of FIRST_TEAMMATE_STARTERS) {
    assert.match(starter.handle, /^[a-z]{3,20}$/);
    assert.ok(starter.name.length > 0 && starter.pitch.length > 0);
    assert.ok(starter.instructions.length >= 80);
    assert.doesNotMatch(starter.instructions, /schedule|every (monday|day|week)|connect (your|a) /i);
  }
});

test('the Chickpea instruction names every starter and defers creation to a choice', () => {
  const instruction = firstTeammateInstruction();
  for (const starter of FIRST_TEAMMATE_STARTERS) {
    assert.ok(instruction.includes(`@${starter.handle} (${starter.name})`));
  }
  assert.match(instruction, /exactly three/);
  assert.match(instruction, /numbered list.*never as a table/);
  assert.match(instruction, /none of them exist yet/);
  assert.match(instruction, /never one you invent/);
  assert.match(instruction, /Do not create anything until they choose/);
  assert.match(instruction, /Do not add Channel reach, connections, or schedules/);
});
