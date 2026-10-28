/**
 * Migrations only add. A schema change may create a table or an index, or add
 * a column that is nullable or has a constant default. It may not drop,
 * rename, change a column's type or definition, add NOT NULL to an existing
 * column, or rewrite data. `verify:hygiene` holds each candidate's migration
 * sources to this against the ones `main` already has.
 *
 * The check reads SQL, not behaviour: a TypeScript migration that rewrites
 * rows through code it cannot see is left to review.
 */

const REMEDY = 'Migrations only add: expand now, and contract in a later release once no code uses the old shape, ' +
  'with a statement marked "-- contract: <reason>" (docs/runbooks/releasing.md).';

/**
 * Durable Object SQLite sources, by how much of their SQL is migration. The
 * config store also holds the application's queries, so only its DDL counts.
 */
const DURABLE_OBJECT_SOURCES = new Map([
  ['src/identity/migrations.ts', 'all'],
  ['src/work/migrations.ts', 'all'],
  ['src/config/store.ts', 'ddl'],
]);
const D1_CHAIN = /^migrations\/better-auth\/[^/]+\.sql$/;

const DDL = /^(?:create (?:unique |temp |temporary )?(?:table|index|view|trigger)|alter table|drop (?:table|index|view|trigger))\b/;
const DML = /^(?:update \S+ set|delete from|insert (?:or \w+ )?into|replace into)\b/;
const CONTRACT = /--\s*contract:\s*\S/i;
const NOT_NULL = /\bnot null\b/;
/** A literal SQLite accepts as `ALTER TABLE ... ADD COLUMN`'s default; an expression or CURRENT_* is not one. */
const CONSTANT_DEFAULT = /\bdefault\s*(?:[-+]?\d|'|null\b|true\b|false\b)/;
const COLUMN_CONSTRAINT = /^(?:constraint|primary|not|null|unique|check|default|collate|references|generated|as)(?![\w$])/;

/** Each refused statement kind, first match wins. A statement no rule names is refused as unrecognized. */
const STATEMENT_RULES = [
  [/^alter table \S+ add (?:column )?(\S+) ?(.*)$/, ([, column, definition]) =>
    NOT_NULL.test(definition) && !CONSTANT_DEFAULT.test(definition) ? `adds NOT NULL column ${unquote(column)} without a constant default` : undefined],
  [/^alter table \S+ rename\b/, () => 'renames'],
  [/^(?:drop|alter table \S+ drop)\b/, () => 'drops'],
  [/^(?:update|delete|replace|insert or replace)\b|^insert\b.*\bselect\b/, () => 'rewrites data'],
  [/^insert\b/, () => undefined],
];

export const isMigrationSource = (path) => DURABLE_OBJECT_SOURCES.has(path) || D1_CHAIN.test(path);
const databaseOf = (path) => (D1_CHAIN.test(path) ? 'D1' : DURABLE_OBJECT_SOURCES.has(path) ? 'Durable Object SQLite' : undefined);

const unquote = (name) => name.replace(/^["`[]|["`\]]$/g, '');
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** Lowercase, comment-free, with whitespace collapsed and none beside parentheses or commas. */
function normalize(sql) {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/ ?([(),]) ?/g, '$1').trim().toLowerCase();
}

/** The string literals in TypeScript source and where each starts. A template substitution reads as `${}`. */
function stringLiterals(source) {
  const literals = [];
  for (let index = 0; index < source.length; index++) {
    const quote = source[index];
    if (quote === '/' && source[index + 1] === '/') { index = source.indexOf('\n', index); if (index < 0) break; continue; }
    if (quote === '/' && source[index + 1] === '*') { index = source.indexOf('*/', index + 2) + 1; if (index <= 0) break; continue; }
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const start = index;
    let text = '';
    for (index++; index < source.length && source[index] !== quote; index++) {
      if (source[index] === '\\') { text += source[++index]; continue; }
      if (quote === '`' && source.startsWith('${', index)) {
        let depth = 0;
        do { depth += source[index] === '{' ? 1 : source[index] === '}' ? -1 : 0; index++; } while (index < source.length && depth > 0);
        index--;
        text += '${}';
        continue;
      }
      text += source[index];
    }
    literals.push({ text, offset: start });
  }
  return literals;
}

/** The migration statements in one source file. */
function statementsOf(path, text) {
  let offset = 0;
  const chunks = path.endsWith('.sql')
    ? text.split(';').map((chunk) => ({ text: chunk, offset: (offset += chunk.length + 1) - chunk.length - 1 }))
    : stringLiterals(text);
  const kinds = DURABLE_OBJECT_SOURCES.get(path) === 'ddl' ? [DDL] : [DDL, DML];
  return chunks.map(({ text: raw, offset }) => ({ raw, offset, sql: normalize(raw) }))
    .filter(({ sql }) => kinds.some((kind) => kind.test(sql)))
    .map(({ raw, offset, sql }) => ({
      sql, contract: CONTRACT.test(raw),
      where: `${path}:${lineAt(text, offset + raw.length - raw.trimStart().length)}`,
    }));
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0, quote, start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) { parts.push(body.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
}

function parseTable(sql) {
  const head = /^create (?:temp |temporary )?table (?:if not exists )?([^\s(]+) ?\(/.exec(sql);
  if (!head) return undefined;
  const columns = new Map();
  const constraints = [];
  for (const part of splitTopLevel(sql.slice(head[0].length, sql.lastIndexOf(')')))) {
    if (/^(?:constraint|primary key|unique|check|foreign key)(?![\w$])/.test(part)) { constraints.push(part); continue; }
    const [name, ...definition] = part.split(' ');
    columns.set(unquote(name), definition.join(' '));
  }
  return { name: unquote(head[1]), columns, constraints: constraints.sort().join(',') };
}

function typeOf(definition) {
  const tokens = definition.split(' ');
  const end = tokens.findIndex((token) => COLUMN_CONSTRAINT.test(token));
  return tokens.slice(0, end < 0 ? tokens.length : end).join(' ');
}

/** A column definition without its default or NOT NULL: changing either alone loosens or keeps what a row may hold. */
const constraintsOf = (definition) => definition.replace(NOT_NULL, '')
  .replace(/\bdefault ?(?:'(?:[^']|'')*'|\((?:[^()]|\([^()]*\))*\)|[^\s,]+)/, '').replace(/ +/g, ' ').trim();

/** What one database's migration sources declare: tables and indexes by name, and every other statement. */
function schemaOf(sources, database) {
  const schema = { tables: new Map(), indexes: new Map(), statements: [], contracted: new Set() };
  for (const [path, text] of sources) {
    if (databaseOf(path) !== database) continue;
    for (const statement of statementsOf(path, text)) {
      const table = parseTable(statement.sql);
      const index = /^create (?:unique )?index (?:if not exists )?(\S+) on\b/.exec(statement.sql);
      if (table) schema.tables.set(table.name, { ...table, where: statement.where });
      else if (index) schema.indexes.set(unquote(index[1]), { sql: statement.sql.replace(' if not exists', ''), where: statement.where });
      else schema.statements.push(statement);
      const dropped = statement.contract && /^(?:drop (table|index) (?:if exists )?(\S+)|alter table (\S+) drop (?:column )?(\S+))/.exec(statement.sql);
      if (dropped) schema.contracted.add(dropped[1] ? `${dropped[1]} ${unquote(dropped[2])}` : `column ${unquote(dropped[3])}.${unquote(dropped[4])}`);
    }
  }
  return schema;
}

function tableChanges(table, before, after, contracted) {
  const changes = [];
  for (const [column, was] of before.columns) {
    const now = after.columns.get(column);
    const name = `${table}.${column}`;
    if (now === undefined) { if (!contracted.has(`column ${name}`)) changes.push(`drops column ${name}`); }
    else if (NOT_NULL.test(now) && !NOT_NULL.test(was)) changes.push(`adds NOT NULL to existing column ${name}`);
    else if (typeOf(now) !== typeOf(was)) changes.push(`changes the type of column ${name} from ${typeOf(was) || 'none'} to ${typeOf(now) || 'none'}`);
    else if (constraintsOf(now) !== constraintsOf(was)) changes.push(`changes the constraints of column ${name}`);
  }
  for (const [column, now] of after.columns) {
    if (!before.columns.has(column) && NOT_NULL.test(now) && !CONSTANT_DEFAULT.test(now)) {
      changes.push(`adds NOT NULL column ${table}.${column} without a constant default`);
    }
  }
  if (before.constraints !== after.constraints) changes.push(`changes the table constraints of ${table}`);
  return changes;
}

function schemaChanges(before, after) {
  const findings = [];
  const refuse = (where, change) => findings.push(`${where}: ${change}. ${REMEDY}`);
  for (const [name, table] of before.tables) {
    const now = after.tables.get(name);
    if (!now) { if (!after.contracted.has(`table ${name}`)) refuse(table.where, `drops table ${name}`); continue; }
    for (const change of tableChanges(name, table, now, after.contracted)) refuse(now.where, change);
  }
  for (const [name, index] of before.indexes) {
    const now = after.indexes.get(name);
    if (!now) { if (!after.contracted.has(`index ${name}`)) refuse(index.where, `drops index ${name}`); }
    else if (now.sql !== index.sql) refuse(now.where, `changes index ${name}`);
  }
  const known = new Set(before.statements.map(({ sql }) => sql));
  for (const { sql, contract, where } of after.statements) {
    if (contract || known.has(sql)) continue;
    const rule = STATEMENT_RULES.find(([pattern]) => pattern.test(sql));
    const change = rule ? rule[1](rule[0].exec(sql)) : 'is not a statement this check recognizes as additive (scripts/lib/additive-migrations.mjs)';
    if (change) refuse(where, `${sql.slice(0, 80)} ${change}`);
  }
  return findings;
}

/**
 * Findings for migration sources (path to text) that do more than add to
 * `base`'s. An applied D1 migration file never changes: D1 does not apply it again.
 */
export function additiveMigrationFindings(base, head) {
  const findings = [];
  for (const [path, text] of base) {
    if (D1_CHAIN.test(path) && head.get(path) !== text) {
      findings.push(`${path}: ${head.has(path) ? 'edits' : 'removes'} an applied D1 migration. Add a new migration file instead.`);
    }
  }
  for (const database of ['Durable Object SQLite', 'D1']) findings.push(...schemaChanges(schemaOf(base, database), schemaOf(head, database)));
  return findings;
}
