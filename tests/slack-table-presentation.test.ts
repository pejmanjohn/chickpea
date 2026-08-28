import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendSlackReplyFooter,
  renderSlackMessage,
} from '../src/slack/message-format.ts';
import {
  appendSlackTableToRenderedMessage,
  createSlackPresentTableTool,
  parseSlackTablePresentation,
  renderSlackTablePresentation,
  SLACK_PRESENT_TABLE_INSTRUCTION,
  type SlackTablePresentation,
} from '../src/slack/table-presentation.ts';

const staticPayrollTable: SlackTablePresentation = {
  caption: 'Relocation bonus allocation for the next Canadian pay run',
  presentation: 'static',
  columns: [
    { header: 'Component', wrap: true },
    { header: 'Amount (CAD)', type: 'number', align: 'right', wrap: false },
  ],
  rows: [
    ['Taxable', 9_350],
    ['Non-taxable', 650],
    ['Employer tax', 420],
    ['Benefits adjustment', 80],
    ['Gross addition', 10_500],
    ['Net one-time earning', 9_920],
    ['Total', 10_000],
  ],
  rowHeaderIndex: 0,
};

test('a static verified result renders as a typed Slack table block', () => {
  const rendered = renderSlackTablePresentation(staticPayrollTable);

  assert.equal(rendered.kind, 'table');
  assert.deepEqual(rendered.block, {
    type: 'table',
    column_settings: [
      { align: 'left', is_wrapped: true },
      { align: 'right', is_wrapped: false },
    ],
    rows: [
      [
        { type: 'raw_text', text: 'Component' },
        { type: 'raw_text', text: 'Amount (CAD)' },
      ],
      [
        { type: 'raw_text', text: 'Taxable' },
        { type: 'raw_number', value: 9_350, text: '9350' },
      ],
      [
        { type: 'raw_text', text: 'Non-taxable' },
        { type: 'raw_number', value: 650, text: '650' },
      ],
      [
        { type: 'raw_text', text: 'Employer tax' },
        { type: 'raw_number', value: 420, text: '420' },
      ],
      [
        { type: 'raw_text', text: 'Benefits adjustment' },
        { type: 'raw_number', value: 80, text: '80' },
      ],
      [
        { type: 'raw_text', text: 'Gross addition' },
        { type: 'raw_number', value: 10_500, text: '10500' },
      ],
      [
        { type: 'raw_text', text: 'Net one-time earning' },
        { type: 'raw_number', value: 9_920, text: '9920' },
      ],
      [
        { type: 'raw_text', text: 'Total' },
        { type: 'raw_number', value: 10_000, text: '10000' },
      ],
    ],
  });
  assert.match(rendered.fallbackMarkdown, /\| Taxable \| 9350 \|/);
  assert.match(rendered.fallbackText, /Component: Total \| Amount \(CAD\): 10000/);
});

test('an explorable synthesized queue renders as an accessible data table', () => {
  const input: SlackTablePresentation = {
    caption: 'Open support queue ordered by customer impact',
    presentation: 'explore',
    columns: [
      { header: 'Ticket' },
      { header: 'Account' },
      { header: 'Age (hours)', type: 'number' },
      { header: 'Affected users', type: 'number' },
    ],
    rows: Array.from({ length: 60 }, (_, index) => [
      `SUP-${String(index + 1).padStart(3, '0')}`,
      `Synthetic account ${index + 1}`,
      (index * 7) % 96,
      10 + ((index * 19) % 900),
    ]),
    pageSize: 15,
    rowHeaderIndex: 0,
  };

  const rendered = renderSlackTablePresentation(input);

  assert.equal(rendered.kind, 'data_table');
  assert.equal(rendered.block.type, 'data_table');
  if (rendered.block.type !== 'data_table') assert.fail('expected data_table');
  assert.equal(rendered.block.caption, input.caption);
  assert.equal(rendered.block.page_size, 15);
  assert.equal(rendered.block.row_header_column_index, 0);
  assert.equal(rendered.block.rows.length, 61);
  assert.deepEqual(rendered.block.rows[1]?.[2], {
    type: 'raw_number', value: 0, text: '0',
  });
});

test('a static table automatically promotes to data_table only when Slack table limits require it', () => {
  const manyRows = renderSlackTablePresentation({
    caption: 'Synthetic inventory snapshot',
    presentation: 'static',
    columns: [{ header: 'SKU' }, { header: 'Units', type: 'number' }],
    rows: Array.from({ length: 100 }, (_, index) => [`SKU-${index + 1}`, index]),
  });
  assert.equal(manyRows.kind, 'data_table', 'header plus 100 rows exceeds table block row limit');

  const manyCharacters = renderSlackTablePresentation({
    caption: 'Synthetic notes snapshot',
    presentation: 'static',
    columns: [{ header: 'Item' }, { header: 'Note', wrap: true }],
    rows: Array.from({ length: 12 }, (_, index) => [
      `Item ${index + 1}`,
      `${index}:`.padEnd(900, 'x'),
    ]),
  });
  assert.equal(manyCharacters.kind, 'data_table', 'table cell text exceeds 10k static limit');
});

test('table validation rejects ragged rows, fake numerics, and Slack cap violations', () => {
  assert.throws(() => parseSlackTablePresentation({
    caption: 'One status record',
    presentation: 'static',
    columns: [{ header: 'Launch' }, { header: 'Owner' }, { header: 'Status' }],
    rows: [['Tuesday', 'Mira', 'On track']],
  }), /single record should be answered with prose or bullets/);

  assert.throws(() => parseSlackTablePresentation({
    caption: 'Three plan comparison',
    presentation: 'static',
    columns: [{ header: 'Plan' }, { header: 'Price' }],
    rows: [['Starter', '$12'], ['Team', '$29'], ['Scale', '$79']],
  }), /compact Markdown table/);

  assert.throws(() => parseSlackTablePresentation({
    ...staticPayrollTable,
    rows: [['Taxable', 9_350], ['Broken']],
  }), /same number of cells/);

  assert.throws(() => parseSlackTablePresentation({
    ...staticPayrollTable,
    rows: [['Taxable', 'CA$9350'], ...staticPayrollTable.rows.slice(1)],
  }), /numeric Slack table column/);

  const normalizedNumerics = parseSlackTablePresentation({
    ...staticPayrollTable,
    rows: staticPayrollTable.rows.map(([label, amount]) => [label, String(amount)]),
  });
  assert.equal(typeof normalizedNumerics.rows[0]?.[1], 'number');
  assert.equal(normalizedNumerics.rows[0]?.[1], 9_350);

  assert.throws(() => parseSlackTablePresentation({
    caption: 'Too wide',
    presentation: 'static',
    columns: Array.from({ length: 21 }, (_, index) => ({ header: `C${index}` })),
    rows: [Array.from({ length: 21 }, () => 'x')],
  }), /invalid/);

  assert.throws(() => parseSlackTablePresentation({
    caption: 'Too tall',
    presentation: 'explore',
    columns: [{ header: 'ID' }],
    rows: Array.from({ length: 201 }, (_, index) => [`R${index}`]),
  }), /invalid/);

  assert.throws(() => parseSlackTablePresentation({
    caption: 'Too much text',
    presentation: 'explore',
    columns: [{ header: 'ID' }, { header: 'Text' }],
    rows: Array.from({ length: 21 }, (_, index) => [
      `R${index}`,
      'x'.repeat(1_000),
    ]),
  }), /20,000-character/);
});

test('table cells redact credentials and provide readable notification fallback', () => {
  const parsed = parseSlackTablePresentation({
    caption: 'Credential scan',
    presentation: 'static',
    columns: [{ header: 'Finding' }, { header: 'Value' }],
    rows: [
      ['Leaked key', 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456'],
      ['Ordinary setting', 'enabled'],
      ['Synthetic setting 2', 'enabled'],
      ['Synthetic setting 3', 'enabled'],
      ['Synthetic setting 4', 'enabled'],
      ['Synthetic setting 5', 'enabled'],
      ['Synthetic setting 6', 'enabled'],
    ],
  });
  const table = renderSlackTablePresentation(parsed);
  const content = appendSlackTableToRenderedMessage(
    renderSlackMessage('One credential-shaped value was removed.', 'markdown'),
    'One credential-shaped value was removed.',
    table,
  );
  const rendered = appendSlackReplyFooter(content, {
    agentName: 'Sprout',
    agentId: 'agent_default',
  });

  assert.match(JSON.stringify(rendered.blocks), /credential redacted/);
  assert.doesNotMatch(JSON.stringify(rendered), /sk-proj-/);
  assert.match(rendered.text, /Finding: Leaked key \| Value: \[credential redacted\]/);
  assert.equal(rendered.blocks?.at(-1)?.type, 'context');
  assert.equal(rendered.blocks?.at(-2)?.type, 'table');
});

test('present_table records exactly one normalized table and then locks', () => {
  const recorded: SlackTablePresentation[] = [];
  const tool = createSlackPresentTableTool((presentation) => recorded.push(presentation));

  assert.deepEqual(tool.run({ data: staticPayrollTable }), {
    output: 'Table recorded. Finish with a short conclusion that does not repeat the rows.',
  });
  assert.equal(recorded.length, 1);
  assert.throws(() => tool.run({ data: staticPayrollTable }), /Only one native Slack table/);
});

test('selection guidance explicitly covers no table, Markdown, static, explore, and artifacts', () => {
  assert.match(SLACK_PRESENT_TABLE_INSTRUCTION, /prose or bullets instead of a table/);
  assert.match(SLACK_PRESENT_TABLE_INSTRUCTION, /Markdown table/);
  assert.match(SLACK_PRESENT_TABLE_INSTRUCTION, /Choose static/);
  assert.match(SLACK_PRESENT_TABLE_INSTRUCTION, /Choose explore/);
  assert.match(SLACK_PRESENT_TABLE_INSTRUCTION, /artifact/);
});
