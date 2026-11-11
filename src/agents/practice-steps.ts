/**
 * What a practice run's settled history becomes for its caller (practice
 * runs §1, addendum 1): the reply, shaped for any client, and each tool call
 * or skill load as a step, with the raw result the Agent read, bounded.
 * Nothing here names an internal ID: an MCP tool by its server's own name,
 * a service by the name an Admin gave it.
 */
import { CONNECTION_REQUEST_METHODS, CONNECTION_REQUEST_TOOL_NAME } from '../connections/request-tool.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';
import { matchesEgressPrefix } from '../config/egress.ts';
import type { PracticeKeptResult, PracticeStep } from '../management/test-run-types.ts';
import { redactCredentialLikeContent } from '../security/content-validation.ts';
import { READ_WEB_PAGE_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from '../web/names.ts';
import { skillDisplayName, type RuntimePlanV2 } from './runtime-plan.ts';

/** The reply a run keeps, in characters. */
export const PRACTICE_REPLY_CHARS = 6_000;
/** A run's raw results together, and one result at most; each gets `min(one, floor(all / results))`. */
const PRACTICE_RESULTS_CHARS = 12_000;
export const PRACTICE_RESULT_CHARS = 1_500;
/**
 * What the store keeps of a run's cut results beyond their excerpts, in
 * characters, all its steps together: each cut result whole, first step
 * first, until this is spent. The result that spends it keeps its start; a
 * later one keeps only its excerpt.
 */
export const PRACTICE_KEPT_RESULTS_CHARS = 400_000;
/** A step's input, `why`, or an `off` line. */
export const PRACTICE_LINE_CHARS = 200;
/** A service's or connection's name, wherever a result shows it: a connection's label can be 160 characters, and each step repeats it. */
const PRACTICE_NAME_CHARS = 60;
/** The steps a result lists, first first; it counts the rest. A run has no limit on its calls, as a direct message has none. */
const PRACTICE_STEPS = 25;

const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';

/** One tool call of the run, as its settled history holds it: an output, or the error the Agent saw. */
export interface PracticeToolCall {
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

interface PracticeSteps {
  steps: PracticeStep[];
  /** The calls past the listed steps. */
  moreSteps?: number;
  /** The services it read, in the order it first read each, over every call: the card's "It read …" line. */
  read: string[];
  /** The skills it loaded, over every call. */
  skills: string[];
  /** More of each cut result than its excerpt, for the store to keep beside the run. */
  results?: PracticeKeptResult[];
}

/**
 * Every call of the run, in order: a skill load as a skill, anything else as
 * a tool. The first 25 are listed, each result cut to the run's bound, and
 * the rest are counted. Each listed result that was cut is also kept as the
 * Agent read it, within the run's total, for get_practice_run to read by step.
 */
export function practiceSteps(plan: RuntimePlanV2, calls: readonly PracticeToolCall[]): PracticeSteps {
  const read = new Set<string>();
  const skills = new Set<string>();
  const steps: PracticeStep[] = [];
  for (const call of calls) {
    const step = call.toolName === ACTIVATE_SKILL_TOOL_NAME ? skillStep(plan, call) : toolStep(plan, call);
    if (step.outcome === 'ok' && step.kind === 'skill') skills.add(step.tool);
    const service = step.kind === 'tool' ? readService(plan, call) : undefined;
    if (step.outcome === 'ok' && service) read.add(service);
    if (steps.length < PRACTICE_STEPS) steps.push(step);
  }
  const more = calls.length - steps.length;
  const listed = bounded(steps);
  const results = keptResults(steps, listed);
  return {
    steps: listed,
    read: [...read],
    skills: [...skills],
    ...more > 0 ? { moreSteps: more } : {},
    ...results.length > 0 ? { results } : {},
  };
}

/**
 * The whole of each result its excerpt cut, first step first, until the
 * run's total is spent; the one that spends it keeps its start, and only
 * when that is more than its excerpt.
 */
function keptResults(whole: readonly PracticeStep[], listed: readonly PracticeStep[]): PracticeKeptResult[] {
  let room = PRACTICE_KEPT_RESULTS_CHARS;
  return whole.flatMap(({ result }, index): PracticeKeptResult[] => {
    const excerpt = listed[index]?.result;
    if (!result || !excerpt) return [];
    const data = result.data.slice(0, room).toWellFormed();
    if (data.length <= excerptLength(excerpt)) return [];
    room -= data.length;
    return [{ step: index + 1, data }];
  });
}

/** An excerpt's own characters, without Chickpea's cut line. */
export function excerptLength(result: NonNullable<PracticeStep['result']>): number {
  return result.truncated ? result.data.lastIndexOf('\n[cut by Chickpea: ') : result.data.length;
}

/**
 * The reply as any client may render it: nothing it would fetch by itself,
 * no raw HTML outside code, cut from the end with Chickpea's line. A cut can
 * end a code span early and leave a tag it held outside it, so whatever cuts
 * the reply escapes it again.
 */
export function practiceReply(text: string): { reply: string; replyTruncated?: true } {
  const shown = escapeHtmlOutsideCode(withoutImages(text));
  return shown.length > PRACTICE_REPLY_CHARS
    ? { reply: escapeHtmlOutsideCode(cut(shown, PRACTICE_REPLY_CHARS)), replyTruncated: true }
    : { reply: shown };
}

/** The first `keep` characters and Chickpea's line saying how much was cut. */
function cut(text: string, keep: number): string {
  return `${text.slice(0, keep)}\n[cut by Chickpea: first ${keep.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters]`;
}

/** One line a client shows as it is: no image, no credential, at most 200 characters. */
export function practiceLine(text: string): string {
  return shortened(redactCredentialLikeContent(withoutImages(text.replace(/\s+/g, ' ').trim())), PRACTICE_LINE_CHARS);
}

/** A service's or connection's name, as a line, at most 60 characters. */
export function practiceName(name: string): string {
  return shortened(practiceLine(name), PRACTICE_NAME_CHARS);
}

function shortened(line: string, most: number): string {
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
}

function skillStep(plan: RuntimePlanV2, call: PracticeToolCall): PracticeStep {
  const asked = (call.input as { name?: unknown } | null | undefined)?.name;
  const name = typeof asked === 'string' ? asked : '';
  return {
    kind: 'skill',
    tool: practiceLine(skillDisplayName(plan, name) ?? (name || 'a skill')),
    outcome: call.error === undefined && !String(call.output ?? '').startsWith('Unknown skill') ? 'ok' : 'failed',
  };
}

function toolStep(plan: RuntimePlanV2, call: PracticeToolCall): PracticeStep {
  const { service, tool } = toolName(plan, call);
  const input = inputLine(call);
  const named = { kind: 'tool' as const, ...service ? { service: practiceLine(service) } : {}, tool: practiceLine(tool), ...input ? { input } : {} };
  if (call.toolName === CONNECTION_REQUEST_TOOL_NAME) {
    const requested = { ...named, method: requestMethod(call.input) };
    return { ...requested, ...call.error !== undefined ? errorOutcome(call.error) : requestOutcome(call.output) };
  }
  if (call.error !== undefined) return { ...named, ...errorOutcome(call.error) };
  const result = raw(asText(call.output));
  if (call.toolName === READ_WEB_PAGE_TOOL_NAME || call.toolName === WEB_SEARCH_TOOL_NAME) {
    return { ...named, ...webOutcome(call.toolName, call.output), result };
  }
  return { ...named, outcome: 'ok', result };
}

/**
 * A web tool answers a refusal or a read that brought nothing back as its
 * output, not as an error: Chickpea's own `outcome` field says which.
 */
function webOutcome(tool: string, output: unknown): Pick<PracticeStep, 'outcome' | 'why'> {
  const said = parsedObject(output);
  if (said?.outcome === 'refused') {
    return {
      outcome: 'refused',
      why: tool === WEB_SEARCH_TOOL_NAME ? 'Chickpea refused this search, so nothing was sent.' : 'Chickpea refused this page, so nothing was read.',
    };
  }
  if (said?.outcome === 'unreadable') {
    return {
      outcome: 'failed',
      why: typeof said.status === 'number' ? `The site answered with HTTP status ${said.status}.` : 'The page couldn\'t be read.',
    };
  }
  if (said?.outcome === 'unavailable') return { outcome: 'failed', why: 'The search service didn\'t answer with results.' };
  return { outcome: 'ok' };
}

/** An output that is a JSON object, or the text of one. */
function parsedObject(output: unknown): Record<string, unknown> | undefined {
  let value = output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The method a request asked for, from its own arguments: GET when it named none, as the tool defaults; "request" for one the tool knows not. */
function requestMethod(input: unknown): string {
  const method = typeof input === 'object' && input !== null ? (input as { method?: unknown }).method : undefined;
  if (method === undefined) return 'GET';
  return (CONNECTION_REQUEST_METHODS as readonly unknown[]).includes(method) ? String(method) : 'request';
}

/** A tool by the name its server or Chickpea gave it, and the service it belongs to. */
function toolName(plan: RuntimePlanV2, call: PracticeToolCall): { service?: string; tool: string } {
  const { toolName: name } = call;
  if (name.startsWith('mcp__')) {
    // Flue names an MCP tool `mcp__<server>__<tool>`, each part sanitized; the server part is a connection's ID.
    const connection = plan.mcpConnections.find(({ id }) => name.startsWith(`mcp__${mcpToolNamePart(id)}__`));
    const part = connection ? name.slice(`mcp__${mcpToolNamePart(connection.id)}__`.length) : name.split('__').slice(2).join('__');
    const tool = connection?.allowedTools.find((allowed) => mcpToolNamePart(allowed) === part) ?? part;
    return { ...connection?.displayName ? { service: connection.displayName } : {}, tool: tool || 'an MCP tool' };
  }
  const service = readService(plan, call);
  return { ...service && service !== 'the web' ? { service } : {}, tool: name };
}

/**
 * The services a run read, by the names an Admin gave them: a managed
 * connector's, a custom MCP or API connection's, or the web. Skills, the
 * shell and calls to nothing named leave none.
 */
function readService(plan: RuntimePlanV2, { toolName, input }: PracticeToolCall): string | undefined {
  if (toolName === WEB_SEARCH_TOOL_NAME || toolName === READ_WEB_PAGE_TOOL_NAME) return 'the web';
  if (toolName.startsWith('mcp__')) {
    return plan.mcpConnections.find(({ id }) => toolName.startsWith(`mcp__${mcpToolNamePart(id)}__`))?.displayName;
  }
  if (toolName === CONNECTION_REQUEST_TOOL_NAME) {
    const url = typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : undefined;
    if (typeof url !== 'string') return undefined;
    return plan.apiConnections.find((connection) => connection.allowedHosts.some((host) =>
      (connection.pathPrefixes.length > 0 ? connection.pathPrefixes : ['']).some((prefix) =>
        matchesEgressPrefix(url, `https://${host}${prefix}`))))?.displayName;
  }
  const capability = MANAGED_CONNECTOR_CATALOG.capabilityForToolName(toolName);
  if (!capability || !plan.managedConnections?.some(({ toolkit, allowedCapabilities }) =>
    toolkit === capability.connectorToolkit && allowedCapabilities.includes(capability.id))) return undefined;
  return MANAGED_CONNECTOR_CATALOG.connector(capability.connectorToolkit)?.label;
}

/** A request's connection is named by the step's service, and its headers never leave. */
function inputLine({ toolName, input }: PracticeToolCall): string | undefined {
  if (input === undefined || input === null) return undefined;
  const shown = toolName === CONNECTION_REQUEST_TOOL_NAME && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'connection' && key !== 'headers'))
    : input;
  const line = practiceLine(asText(shown));
  return line && line !== '{}' ? line : undefined;
}

/** Chickpea's own refusals by their sentence; anything else is the tool's failure, with what it said. */
function errorOutcome(error: string): Pick<PracticeStep, 'outcome' | 'why' | 'result'> {
  if (error.includes('MCP connection policy changed')) {
    return { outcome: 'refused', why: 'This tool is not marked as a read now, so a practice run can\'t call it.' };
  }
  if (error.includes('MCP tool is not selected for this Agent')) {
    return { outcome: 'refused', why: 'The connection doesn\'t allow this tool.' };
  }
  return { outcome: 'failed', why: 'The tool call failed.', result: raw(error) };
}

/**
 * A connection request's outcome from its own output. The result keeps the
 * status, URL and response the Agent read; the connection's ID and the
 * echoed response headers never leave, and a refusal that lists the Agent's
 * connections lists them by name.
 */
function requestOutcome(output: unknown): Pick<PracticeStep, 'outcome' | 'why' | 'result'> {
  const shown = typeof output === 'object' && output !== null ? output as Record<string, unknown> : {};
  const data = Object.fromEntries(Object.entries(shown).flatMap(([key, value]) => {
    if (['connection', 'displayName', 'headers'].includes(key)) return [];
    if (key !== 'connections') return [[key, value]];
    return [[key, (Array.isArray(value) ? value : []).flatMap((listed: unknown) => {
      const name = (listed as { displayName?: unknown } | null)?.displayName;
      return typeof name === 'string' ? [name] : [];
    })]];
  }));
  const result = raw(asText(data));
  if (shown.sent === false) {
    if (shown.reason === 'write_not_allowed') return { outcome: 'refused', why: 'This run can only read through connections.', result };
    if (shown.reason === 'failed') return { outcome: 'failed', why: 'The request didn\'t complete: a network error or a timeout.', result };
    return { outcome: 'refused', why: 'The connection doesn\'t allow that request.', result };
  }
  if (shown.ok === false && typeof shown.status === 'number') {
    return { outcome: 'failed', why: `The service answered with HTTP status ${shown.status}.`, result };
  }
  return { outcome: 'ok', result };
}

/** What the Agent read, as text: no credential, no control character but a line break or tab. */
function raw(text: string): NonNullable<PracticeStep['result']> {
  // eslint-disable-next-line no-control-regex
  const data = redactCredentialLikeContent(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return { data, size: data.length, truncated: false };
}

/** Each result cut from the end to `min(one, floor(all / results))`, with Chickpea's line. */
function bounded(steps: PracticeStep[]): PracticeStep[] {
  const results = steps.filter(({ result }) => result).length;
  const each = Math.min(PRACTICE_RESULT_CHARS, Math.floor(PRACTICE_RESULTS_CHARS / Math.max(1, results)));
  return steps.map((step) => step.result ? { ...step, result: cutResult(step.result, each) } : step);
}

/** A result cut to `keep` characters of its data, again if it was cut before; `size` stays its length before any cut. */
export function cutResult(result: NonNullable<PracticeStep['result']>, keep: number): NonNullable<PracticeStep['result']> {
  const kept = result.data.slice(0, excerptLength(result));
  if (kept.length <= keep) return result;
  return {
    data: `${kept.slice(0, keep)}\n[cut by Chickpea: first ${keep.toLocaleString('en-US')} of ${result.size.toLocaleString('en-US')} characters]`,
    size: result.size,
    truncated: true,
  };
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function mcpToolNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

/**
 * A `<` that could open a tag or an autolink becomes `&lt;` outside code,
 * where no client should render one. A fence that starts a line, or one
 * space in, keeps its text, and so do the code spans of a paragraph whose
 * every backtick pairs on its own line, so `Map<string, number>` and HTML
 * samples arrive as written. Anywhere a client could pair backticks another
 * way, everything is escaped: the whole paragraph around a doubtful line,
 * and the rest of the reply from a fence indented two or three spaces, which
 * can sit in a list item that ends before the fence does, or from one whose
 * line holds a `|`, or from a fence line indented with a tab, in code or out
 * of it: a tab's width depends on where its line starts, so behind a quote
 * mark, as the text block shows the reply, that line opens or closes a fence
 * it does not here. Line endings come back as `\n`.
 */
export function escapeHtmlOutsideCode(markdown: string): string {
  const shown: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let rest = false;
  let paragraph: string[] = [];
  const endParagraph = (doubt = false) => {
    const read = paragraph.map(escapeOutsideSpans);
    const kept = !doubt && read.every(({ doubtful }) => !doubtful);
    shown.push(...read.map(({ shown: line }, index) => kept ? line : escapeTags(paragraph[index]!)));
    paragraph = [];
  };
  // A lone carriage return ends a line for a client too.
  for (const line of markdown.split(/\r\n?|\n/)) {
    const opener = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    const marker = opener?.[2];
    if (!rest && /^ *\t[ \t]*(?:`{3,}|~{3,})/.test(line)) {
      // Here the line runs its paragraph on, and its backticks can pair with any before it.
      if (!fence) endParagraph(true);
      fence = undefined;
      rest = true;
    }
    if (fence) {
      // Only spaces and tabs may follow a closing fence: a client keeps reading code past any other space.
      if (marker && marker[0] === fence.char && marker.length >= fence.length &&
          /^[ \t]*$/.test(line.slice(opener[0].length))) fence = undefined;
      shown.push(line);
    } else if (rest) {
      shown.push(escapeTags(line));
    } else if (marker && !(marker[0] === '`' && line.slice(opener[0].length).includes('`'))) {
      endParagraph();
      // markdown-it reads a fence line that holds a `|` as a table's header when a delimiter row follows it.
      if (opener[1]!.length >= 2 || line.includes('|')) {
        rest = true;
        shown.push(escapeTags(line));
      } else {
        fence = { char: marker[0]!, length: marker.length };
        shown.push(line);
      }
    } else if (/^[ \t]*$/.test(line)) {
      // A line of any other space, such as a no-break space, is text: the paragraph runs on.
      endParagraph();
      shown.push(line);
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return shown.join('\n');
}

/**
 * One line with its code spans kept. A span opens with a run of backticks
 * and closes at the next run of exactly its length; a backslash before a run
 * escapes its first backtick, and inside a span a backslash is text.
 * `doubtful`: a client may read this line's backticks another way, so no
 * span in its paragraph is kept. That is a run with no partner on the line,
 * which a client can pair across lines or leave as text; a span across a
 * `|`, where a table splits its row before it reads a cell's code; and a
 * backtick a link or a bare web address keeps as its own text.
 */
function escapeOutsideSpans(line: string): { shown: string; doubtful: boolean } {
  const runs = [...line.matchAll(/`+/g)].map((match) => ({ at: match.index, length: match[0].length }));
  let shown = '';
  let from = 0;
  let doubtful = linkHoldsBacktick(line);
  for (let open = 0; open < runs.length; open += 1) {
    const run = runs[open]!;
    const before = line.slice(from, run.at);
    // An address written bare runs on through a backtick, to the next space, under any scheme a client links: ftp too.
    if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*$/i.test(before)) doubtful = true;
    const escaped = /\\*$/.exec(before)![0].length % 2 === 1;
    const opening = escaped ? { at: run.at + 1, length: run.length - 1 } : run;
    if (opening.length === 0) continue;
    const close = runs.findIndex((other, index) => index > open && other.length === opening.length);
    if (close < 0) {
      doubtful = true;
      continue;
    }
    const end = runs[close]!.at + runs[close]!.length;
    if (line.slice(opening.at, end).includes('|')) doubtful = true;
    shown += escapeTags(line.slice(from, opening.at)) + line.slice(opening.at, end);
    from = end;
    open = close;
  }
  return { shown: shown + escapeTags(line.slice(from)), doubtful };
}

/**
 * A link's destination, title or reference label, and a footnote's label,
 * keep a backtick as their own text. True when one of them on this line
 * holds a backtick, or does not plainly end on it: a destination or a title
 * can run on to the next line, and a title, a nested parenthesis, an angle
 * bracket or an escape can hold the character that would end it.
 */
function linkHoldsBacktick(line: string): boolean {
  for (const tail of line.matchAll(/\][([]|\[\^/g)) {
    const from = tail.index + 2;
    const end = line.indexOf(tail[0] === '](' ? ')' : ']', from);
    if (end < 0 || /[`"'(<\\]/.test(line.slice(from, end))) return true;
  }
  return false;
}

/** A `<` before a space opens nothing, so `a < b` stays as written. */
function escapeTags(text: string): string {
  return text.replace(/<(?=\S)/g, '&lt;');
}

/**
 * The reply with nothing a client would fetch on its own: each Markdown or
 * HTML image becomes its alt text, or its address as plain text when it has
 * none, so a prompt injection cannot get a URL loaded without a click. Code
 * is rewritten too, since a client may not split code where this would. Any
 * `![` or `<img` left over, or formed by a rewrite, is escaped.
 */
export function withoutImages(markdown: string): string {
  const definitions = new Map<string, string>();
  for (const [, label, address] of markdown.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?/gm)) {
    definitions.set(referenceLabel(label!), address!);
  }
  return markdownImagesAsText(markdown, definitions)
    .replace(/<img\b[^>]{0,2000}>/gi, (tag) => htmlAttribute(tag, 'alt') || htmlAttribute(tag, 'src'))
    .replaceAll('![', '!\\[')
    .replace(/<img/gi, '&lt;img');
}

/** One pass: an image's alt is kept as written, nested images in it included, for the final escape. */
function markdownImagesAsText(text: string, definitions: ReadonlyMap<string, string>): string {
  const closes = matchingBrackets(text);
  let shown = '';
  let at = 0;
  for (let start = text.indexOf('![', at); start >= 0; start = text.indexOf('![', at)) {
    shown += text.slice(at, start);
    at = start + 2;
    const altEnd = closes.get(start + 1);
    if (altEnd === undefined) {
      shown += '![';
      continue;
    }
    const alt = text.slice(start + 2, altEnd).trim();
    let address = definitions.get(referenceLabel(alt)) ?? '';
    at = altEnd + 1;
    const end = closes.get(at);
    if (end !== undefined && text[at] === '(') {
      const destination = text.slice(at + 1, end).trim();
      address = destination.startsWith('<') ? destination.slice(1).split('>')[0]! : destination.split(/\s/)[0]!;
      at = end + 1;
    } else if (end !== undefined) {
      address = definitions.get(referenceLabel(text.slice(at + 1, end) || alt)) ?? '';
      at = end + 1;
    }
    shown += alt || address;
  }
  return shown + text.slice(at);
}

/** Each `[` and `(` with the index of the bracket that closes it, nested pairs and escaped brackets skipped. */
function matchingBrackets(text: string): Map<number, number> {
  const closes = new Map<number, number>();
  const squares: number[] = [];
  const rounds: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') index += 1;
    else if (char === '[') squares.push(index);
    else if (char === '(') rounds.push(index);
    else if (char === ']' || char === ')') {
      const opener = (char === ']' ? squares : rounds).pop();
      if (opener !== undefined) closes.set(opener, index);
    }
  }
  return closes;
}

function referenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function htmlAttribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}
