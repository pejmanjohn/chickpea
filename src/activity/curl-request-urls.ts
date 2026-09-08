// Activity narration only needs literal commands and literal curl requests.
// This intentionally implements a conservative shell subset: ambiguous syntax
// returns undefined so callers can fall back to a generic, non-attributed status.

export interface ParsedShellCommand {
  words: readonly string[];
  hasOutputRedirection: boolean;
}

export interface CurlRequest {
  url: string;
  method: string;
}

const CURL_LONG_NO_VALUE_FLAGS = new Set([
  '--compressed',
  '--fail',
  '--fail-with-body',
  '--globoff',
  '--http1.0',
  '--http1.1',
  '--http2',
  '--http2-prior-knowledge',
  '--http3',
  '--include',
  '--insecure',
  '--ipv4',
  '--ipv6',
  '--location',
  '--location-trusted',
  '--no-buffer',
  '--no-progress-meter',
  '--parallel',
  '--parallel-immediate',
  '--path-as-is',
  '--remote-header-name',
  '--remote-name',
  '--retry-all-errors',
  '--retry-connrefused',
  '--show-error',
  '--silent',
  '--ssl-no-revoke',
  '--verbose',
]);

const CURL_LONG_VALUE_FLAGS = new Set([
  '--cacert',
  '--capath',
  '--cert',
  '--cert-type',
  '--ciphers',
  '--connect-timeout',
  '--connect-to',
  '--cookie',
  '--cookie-jar',
  '--crlfile',
  '--doh-url',
  '--dump-header',
  '--etag-compare',
  '--etag-save',
  '--expect100-timeout',
  '--header',
  '--interface',
  '--key',
  '--key-type',
  '--limit-rate',
  '--local-port',
  '--max-filesize',
  '--max-redirs',
  '--max-time',
  '--netrc-file',
  '--oauth2-bearer',
  '--output',
  '--pass',
  '--pinnedpubkey',
  '--proxy',
  '--proxy-cacert',
  '--proxy-capath',
  '--proxy-cert',
  '--proxy-header',
  '--proxy-key',
  '--proxy-pass',
  '--proxy-user',
  '--pubkey',
  '--quote',
  '--range',
  '--referer',
  '--request-target',
  '--resolve',
  '--retry',
  '--retry-delay',
  '--retry-max-time',
  '--service-name',
  '--speed-limit',
  '--speed-time',
  '--stderr',
  '--telnet-option',
  '--tftp-blksize',
  '--time-cond',
  '--tls-max',
  '--unix-socket',
  '--user',
  '--user-agent',
  '--write-out',
]);

const CURL_DATA_FLAGS = new Set([
  '--data',
  '--data-ascii',
  '--data-binary',
  '--data-raw',
  '--data-urlencode',
  '--form',
  '--form-string',
  '--json',
]);

// Every unlisted short option is treated as value-taking. That can hide a
// legitimate request URL, but a false-negative generic status is safer than
// treating a header, body, proxy, certificate, or output as a request URL.
const CURL_SHORT_NO_VALUE_FLAGS = new Set('012346aBfgGhIiJjklLMnNOqRsSvVZ#'.split(''));

interface CurlTransfer {
  urls: string[];
  explicitMethod?: string;
  hasData: boolean;
  hasUpload: boolean;
  forceGet: boolean;
  head: boolean;
}

interface PendingRedirection {
  heredoc?: { stripTabs: boolean };
}

interface HereDocument {
  delimiter: string;
  stripTabs: boolean;
}

export function extractCurlRequests(command: string): CurlRequest[] | undefined {
  const commands = parseShellCommands(command);
  if (!commands) return undefined;

  const requests: CurlRequest[] = [];
  for (const parsed of commands) {
    let commandIndex = 0;
    while (isAssignment(parsed.words[commandIndex])) commandIndex += 1;
    if (parsed.words[commandIndex] === 'command') commandIndex += 1;
    if (parsed.words[commandIndex] !== 'curl') continue;

    const parsedRequests = curlRequestsFromArgs(parsed.words.slice(commandIndex + 1));
    if (!parsedRequests) return undefined;
    requests.push(...parsedRequests);
  }
  return requests;
}

function curlRequestsFromArgs(args: readonly string[]): CurlRequest[] | undefined {
  const requests: CurlRequest[] = [];
  let transfer = emptyCurlTransfer();
  let afterOptions = false;

  const finishTransfer = (): boolean => {
    if (transfer.urls.length === 0) return false;
    const method = effectiveCurlMethod(transfer);
    if (!method) return false;
    requests.push(...transfer.urls.map((url) => ({ url, method })));
    transfer = emptyCurlTransfer();
    afterOptions = false;
    return true;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (afterOptions) {
      const url = literalHttpsUrl(arg);
      if (!url) return undefined;
      transfer.urls.push(url);
      continue;
    }
    if (arg === '--') {
      afterOptions = true;
      continue;
    }
    if (arg === '--next') {
      if (!finishTransfer()) return undefined;
      continue;
    }
    if (arg.startsWith('--')) {
      const equalsAt = arg.indexOf('=');
      const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
      const inlineValue = equalsAt === -1 ? undefined : arg.slice(equalsAt + 1);

      if (flag === '--get' || flag === '--head') {
        if (inlineValue !== undefined) return undefined;
        if (flag === '--get') transfer.forceGet = true;
        else transfer.head = true;
        continue;
      }
      if (CURL_LONG_NO_VALUE_FLAGS.has(flag)) {
        if (inlineValue !== undefined) return undefined;
        continue;
      }
      if (flag === '--config') return undefined;

      const takesValue =
        flag === '--url' ||
        flag === '--request' ||
        flag === '--upload-file' ||
        CURL_DATA_FLAGS.has(flag) ||
        CURL_LONG_VALUE_FLAGS.has(flag);
      if (!takesValue) return undefined;

      const value = inlineValue ?? args[index + 1];
      if (value === undefined || value === '') return undefined;
      if (inlineValue === undefined) index += 1;

      if (flag === '--url') {
        const url = literalHttpsUrl(value);
        if (!url) return undefined;
        transfer.urls.push(url);
      } else if (flag === '--request') {
        const method = normalizeHttpMethod(value);
        if (!method) return undefined;
        transfer.explicitMethod = method;
      } else if (flag === '--upload-file') {
        transfer.hasUpload = true;
      } else if (CURL_DATA_FLAGS.has(flag)) {
        transfer.hasData = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const consumedThrough = applyShortCurlOptions(args, index, transfer);
      if (consumedThrough === undefined) return undefined;
      index = consumedThrough;
      continue;
    }

    const url = literalHttpsUrl(arg);
    if (!url) return undefined;
    transfer.urls.push(url);
  }

  if (transfer.urls.length > 0) {
    if (!finishTransfer()) return undefined;
  }
  return requests;
}

function applyShortCurlOptions(
  args: readonly string[],
  optionIndex: number,
  transfer: CurlTransfer,
): number | undefined {
  const arg = args[optionIndex] ?? '';
  for (let index = 1; index < arg.length; index += 1) {
    const flag = arg[index] ?? '';
    if (CURL_SHORT_NO_VALUE_FLAGS.has(flag)) {
      if (flag === 'G') transfer.forceGet = true;
      if (flag === 'I') transfer.head = true;
      continue;
    }
    // -K/--config can introduce arbitrary options and URLs from another file.
    if (flag === 'K') return undefined;

    const attached = arg.slice(index + 1);
    const value = attached || args[optionIndex + 1];
    if (value === undefined || value === '') return undefined;
    const consumedThrough = attached ? optionIndex : optionIndex + 1;

    if (flag === 'X') {
      const method = normalizeHttpMethod(value);
      if (!method) return undefined;
      transfer.explicitMethod = method;
    } else if (flag === 'd' || flag === 'F') {
      transfer.hasData = true;
    } else if (flag === 'T') {
      transfer.hasUpload = true;
    }
    // A value-taking short option consumes the remainder of this argument.
    return consumedThrough;
  }
  return optionIndex;
}

function emptyCurlTransfer(): CurlTransfer {
  return { urls: [], hasData: false, hasUpload: false, forceGet: false, head: false };
}

function effectiveCurlMethod(transfer: CurlTransfer): string | undefined {
  if (transfer.explicitMethod) return transfer.explicitMethod;
  if (transfer.head && (transfer.forceGet || transfer.hasData || transfer.hasUpload)) {
    return undefined;
  }
  if (transfer.hasUpload && (transfer.forceGet || transfer.hasData)) return undefined;
  if (transfer.head) return 'HEAD';
  if (transfer.forceGet) return 'GET';
  if (transfer.hasUpload) return 'PUT';
  if (transfer.hasData) return 'POST';
  return 'GET';
}

function normalizeHttpMethod(value: string): string | undefined {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) ? value.toUpperCase() : undefined;
}

function literalHttpsUrl(word: string): string | undefined {
  if (!/^https:\/\//i.test(word)) return undefined;
  try {
    return new URL(word).href;
  } catch {
    return undefined;
  }
}

function isAssignment(word: string | undefined): boolean {
  return typeof word === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

export function parseShellCommands(source: string): ParsedShellCommand[] | undefined {
  const commands: ParsedShellCommand[] = [];
  let words: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: "'" | '"' | undefined;
  let pendingRedirection: PendingRedirection | undefined;
  let hereDocuments: HereDocument[] = [];
  let hasOutputRedirection = false;
  let invalid = false;

  const finishWord = () => {
    if (!wordStarted) return;
    const finished = word;
    word = '';
    wordStarted = false;
    if (pendingRedirection) {
      if (finished === '') {
        invalid = true;
        return;
      }
      if (pendingRedirection.heredoc) {
        hereDocuments.push({
          delimiter: finished,
          stripTabs: pendingRedirection.heredoc.stripTabs,
        });
      }
      pendingRedirection = undefined;
      return;
    }
    words.push(finished);
  };
  const finishCommand = () => {
    finishWord();
    if (pendingRedirection) {
      invalid = true;
      return;
    }
    if (words.length > 0 || hasOutputRedirection) {
      commands.push({ words, hasOutputRedirection });
    }
    words = [];
    hasOutputRedirection = false;
  };
  const beginRedirection = (redirection: PendingRedirection, output: boolean) => {
    if (pendingRedirection) {
      invalid = true;
      return;
    }
    // With no intervening whitespace, a numeric word is an fd designator.
    if (wordStarted && /^\d+$/.test(word)) {
      word = '';
      wordStarted = false;
    } else {
      finishWord();
    }
    pendingRedirection = redirection;
    if (output) hasOutputRedirection = true;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    const next = source[index + 1];

    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === '`' || (char === '$' && next === '(')) return undefined;
      if (char === '\\' && next !== undefined) {
        if (next === '\n') index += 1;
        else {
          word += next;
          index += 1;
        }
      } else {
        word += char;
      }
      continue;
    }

    if (char === '`' || (char === '$' && next === '(')) return undefined;
    if (char === '\\') {
      if (next === undefined) return undefined;
      if (next === '\n') {
        index += 1;
      } else {
        wordStarted = true;
        word += next;
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === '#' && !wordStarted) {
      const newline = source.indexOf('\n', index + 1);
      if (newline === -1) {
        index = source.length;
        break;
      }
      index = newline - 1;
      continue;
    }
    if (char === '&' && next === '>') {
      beginRedirection({}, true);
      index += source[index + 2] === '>' ? 2 : 1;
      continue;
    }
    if (char === '<' || char === '>') {
      if (char === '<' && next === '<') {
        if (source[index + 2] === '<') return undefined;
        const stripTabs = source[index + 2] === '-';
        beginRedirection({ heredoc: { stripTabs } }, false);
        index += stripTabs ? 2 : 1;
      } else {
        const output = char === '>' || next === '>';
        beginRedirection({}, output);
        if (next === char || next === '&' || next === '|' || (char === '<' && next === '>')) {
          index += 1;
        }
      }
      continue;
    }
    if (char === '\n') {
      finishCommand();
      if (invalid) return undefined;
      if (hereDocuments.length > 0) {
        const afterHereDocuments = consumeHereDocuments(source, index + 1, hereDocuments);
        if (afterHereDocuments === undefined) return undefined;
        hereDocuments = [];
        index = afterHereDocuments - 1;
      }
      continue;
    }
    if (';|&'.includes(char)) {
      finishCommand();
      if (invalid) return undefined;
      if (next === char && (char === '|' || char === '&')) index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      finishWord();
      if (invalid) return undefined;
      continue;
    }
    if ('(){}'.includes(char)) return undefined;
    wordStarted = true;
    word += char;
  }

  if (quote) return undefined;
  finishCommand();
  return invalid ? undefined : commands;
}

function consumeHereDocuments(
  source: string,
  start: number,
  documents: readonly HereDocument[],
): number | undefined {
  let cursor = start;
  for (const document of documents) {
    let found = false;
    while (cursor <= source.length) {
      const newline = source.indexOf('\n', cursor);
      const end = newline === -1 ? source.length : newline;
      const rawLine = source.slice(cursor, end).replace(/\r$/, '');
      const line = document.stripTabs ? rawLine.replace(/^\t+/, '') : rawLine;
      cursor = newline === -1 ? source.length : newline + 1;
      if (line === document.delimiter) {
        found = true;
        break;
      }
      if (newline === -1) break;
    }
    if (!found) return undefined;
  }
  return cursor;
}
