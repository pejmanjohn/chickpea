/**
 * The RPC surface of every Durable Object class the Worker deploys, read
 * through the TypeScript checker: each public method's parameters and
 * awaited return, with every named type expanded once into `types`.
 *
 * A held object keeps serving its old build for minutes after a deploy while
 * new code calls it, and it calls new objects in turn. So what crosses an
 * object boundary is a contract between two builds, and this file is its
 * reader. `rpc-contract.mjs` compares two surfaces.
 *
 * A type node is one of:
 *   'string', '"literal"', 'T'           a primitive, literal or type parameter
 *   '#Name'                              a named type, defined in `types`
 *   'lib:Request'                        a TypeScript or platform type, by name
 *   'ext:@flue/runtime:Name'             a dependency's type, by package and name
 *   { ref: '#Name' | 'lib:…' | 'ext:…', args: [...] }   a generic one
 *   { union: [...] }, { allOf: [...] }, { array: node }, { tuple: [...] }
 *   { object: { prop: node, 'opt?': node }, index?: node }
 *   { conditional: [check, extends, true, false] }, { indexed: [object, index] }, { keyof: node }
 *   { fn: 'text' }                       a function type, compared as text
 *   'text:…'                             a template literal type, compared as text
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

export const SURFACE_SCHEMA = 1;

/** Types serialized as JSON strings across an object boundary, which a method signature shows only as `string`. */
export const PAYLOADS = [
  { name: 'SlackTurnInputV1', source: 'src/agents/turn-input.ts', note: 'chickpeaStageTurnInput(json)' },
  { name: 'CodingWorkerBinding', source: 'src/sandbox/coding-worker-binding.ts', note: 'chickpeaStageCodingWorkerBinding(json)' },
  { name: 'ThreadRunnerJobPayload', source: 'src/slack/thread-runner-rpc.ts', note: 'SlackThreadRunner.admit(job), as job.payload' },
];

/** The Flue-generated class name for an agent: chickpea-slack-v2 becomes FlueChickpeaSlackV2Agent. */
export const flueAgentClassName = (agentName) =>
  `Flue${agentName.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('')}Agent`;

const LIB_PACKAGES = new Set(['typescript', '@types/node']);

/** The class whose methods `withStoreFallback` (src/config/store-fallback.ts) can wrap. */
export const STATE_STORE_CLASS = 'TagStateStore';

/** The classes `wrangler.jsonc` deploys: every class a migration created and no later migration deleted. */
export function deployedClasses(root) {
  const file = path.join(root, 'wrangler.jsonc');
  const { config, error } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  if (error) throw new Error(`wrangler.jsonc: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  const live = new Set();
  for (const migration of config.migrations ?? []) {
    for (const name of [...(migration.new_sqlite_classes ?? []), ...(migration.new_classes ?? [])]) live.add(name);
    for (const name of migration.deleted_classes ?? []) live.delete(name);
    for (const { from, to } of migration.renamed_classes ?? []) { live.delete(from); live.add(to); }
  }
  return [...live].sort();
}

function lockedVersions(root) {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return (name) => lock.packages?.[`node_modules/${name}`]?.version;
}

function program(root) {
  const configPath = path.join(root, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  const sources = parsed.fileNames.filter((file) => {
    const relative = path.relative(root, file);
    return relative.startsWith(`src${path.sep}`) || relative.startsWith(`types${path.sep}`);
  });
  return ts.createProgram({ rootNames: sources, options: { ...parsed.options, noEmit: true } });
}

function unwrapExpression(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
}

/**
 * Reads one program's surface. `root` is a Core checkout with its
 * dependencies installed (or linked).
 */
export function readSurface(root, { payloads: payloadTypes = PAYLOADS } = {}) {
  const prog = program(root);
  const checker = prog.getTypeChecker();
  const versionOf = lockedVersions(root);
  const relative = (file) => path.relative(root, file).split(path.sep).join('/');
  const srcFiles = prog.getSourceFiles().filter((file) => relative(file.fileName).startsWith('src/'));

  const resolve = (symbol) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const declarationOf = (node) => resolve(checker.getSymbolAtLocation(node))?.declarations?.[0];

  /** The class a function returns, for Flue extensions and the mixins they extend. */
  function returnedClass(fn) {
    if (!fn) return undefined;
    if (ts.isVariableDeclaration(fn)) fn = unwrapExpression(fn.initializer);
    if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn))) return undefined;
    const body = fn.body && ts.isBlock(fn.body) ? undefined : unwrapExpression(fn.body);
    if (body && ts.isClassExpression(body)) return body;
    let found;
    const visit = (node) => {
      if (found || (node !== fn && ts.isFunctionLike(node))) return;
      if (ts.isReturnStatement(node)) {
        const value = unwrapExpression(node.expression);
        const returned = value && ts.isIdentifier(value) ? declarationOf(value) : value;
        if (returned && ts.isClassLike(returned)) { found = returned; return; }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn, visit);
    return found;
  }

  const extendsExpression = (classNode) =>
    classNode.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;

  /**
   * A class and the classes it extends in this program's own source, nearest
   * first: a class, a mixin call, or a variable holding either. A mixin's
   * class extends its parameter, so its chain goes on in the call's
   * arguments. The chain ends at an outside base or a parameter. A mixin
   * whose class cannot be read fails the run, so its methods are not
   * silently left out.
   */
  function classChain(expression) {
    expression = unwrapExpression(expression);
    if (!expression) return [];
    if (ts.isClassLike(expression)) return [expression, ...classChain(extendsExpression(expression))];
    const callee = ts.isCallExpression(expression) ? unwrapExpression(expression.expression) : expression;
    const declaration = declarationOf(callee);
    if (!declaration || !isOwnSource(declaration.getSourceFile())) return [];
    if (ts.isCallExpression(expression)) {
      const returned = returnedClass(declaration);
      if (!returned) throw new Error(`The RPC contract cannot read the class that ${callee.getText()}() returns (${relative(declaration.getSourceFile().fileName)}); return a class from it directly`);
      return [...classChain(returned), ...expression.arguments.flatMap(classChain)];
    }
    if (ts.isClassLike(declaration)) return classChain(declaration);
    if (ts.isVariableDeclaration(declaration)) return classChain(declaration.initializer);
    return [];
  }

  /** The outside package a class chain ends at, as `package version`; undefined at DurableObject itself. */
  function outsideBase(chain) {
    const node = chain.at(-1);
    const expression = unwrapExpression(extendsExpression(node));
    if (!expression) return undefined;
    const file = declarationOf(ts.isCallExpression(expression) ? unwrapExpression(expression.expression) : expression)?.getSourceFile();
    const pkg = file && packageOf(file.fileName);
    return pkg ? `${pkg} ${versionOf(pkg) ?? 'unknown'}` : undefined;
  }

  const isOwnSource = (file) => !file.isDeclarationFile && relative(file.fileName).startsWith('src/');

  function packageOf(fileName) {
    const parts = fileName.split(path.sep);
    const index = parts.lastIndexOf('node_modules');
    if (index < 0) return undefined;
    return parts[index + 1]?.startsWith('@') ? `${parts[index + 1]}/${parts[index + 2]}` : parts[index + 1];
  }

  const classNodes = new Map();
  const agentModules = new Map();
  for (const file of srcFiles) {
    let agentName;
    let extension;
    for (const statement of file.statements) {
      if (ts.isClassDeclaration(statement) && statement.name
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        classNodes.set(statement.name.text, statement);
      }
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(statement.expression.left)
        && statement.expression.left.name.text === 'agentName'
        && ts.isStringLiteralLike(statement.expression.right)) {
        agentName = statement.expression.right.text;
      }
      if (ts.isVariableStatement(statement)
        && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === 'cloudflare') extension = declaration.initializer;
        }
      }
    }
    if (agentName) agentModules.set(flueAgentClassName(agentName), { file, extension });
  }

  function extensionClass(expression) {
    let value = unwrapExpression(expression);
    if (value && ts.isIdentifier(value)) {
      const declaration = declarationOf(value);
      value = declaration && ts.isVariableDeclaration(declaration) ? unwrapExpression(declaration.initializer) : undefined;
    }
    if (!value || !ts.isObjectLiteralExpression(value)) return undefined;
    const base = value.properties.find((property) => property.name && ts.isIdentifier(property.name) && property.name.text === 'base');
    if (!base) return undefined;
    const initializer = ts.isPropertyAssignment(base) ? unwrapExpression(base.initializer) : ts.isShorthandPropertyAssignment(base) ? base.name : undefined;
    if (!initializer) return undefined;
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return returnedClass(initializer);
    return returnedClass(declarationOf(initializer));
  }

  // Flue generates each Agent class over the Agents SDK's base, which package.json pins on its own.
  const agentBase = ['@flue/runtime', 'agents'].map((pkg) => `${pkg} ${versionOf(pkg) ?? 'unknown'}`).join(', ');
  const targets = [];
  const unknown = [];
  for (const name of deployedClasses(root)) {
    const declared = classNodes.get(name);
    if (declared) { targets.push({ name, node: declared, file: declared.getSourceFile() }); continue; }
    const agent = agentModules.get(name);
    if (agent) {
      const node = agent.extension ? extensionClass(agent.extension) : undefined;
      if (agent.extension && !node) unknown.push(`${name}: its cloudflare export names no class this check can read`);
      targets.push({ name, node, file: agent.file, base: agentBase });
      continue;
    }
    unknown.push(`${name}: wrangler.jsonc deploys it, but no exported class or Flue agent in src declares it`);
  }
  if (unknown.length) throw new Error(`The RPC contract cannot read every deployed class:\n  ${unknown.join('\n  ')}`);

  const defs = new Map();
  const symbolNames = new Map();
  const placeholder = (symbol) => {
    if (!symbolNames.has(symbol)) symbolNames.set(symbol, { id: `@@${symbolNames.size}@@`, symbol });
    return symbolNames.get(symbol).id;
  };
  const externals = new Set();
  const isLibFile = (file) => prog.isSourceFileDefaultLibrary(file) || LIB_PACKAGES.has(packageOf(file.fileName))
    || relative(file.fileName).startsWith('types/');
  const declarationFile = (symbol) => symbol?.declarations?.[0]?.getSourceFile();

  const BOOLEAN_PAIR = ['false', 'true'];

  function serialize(type, top = false, depth = 0) {
    if (depth > 60) throw new Error(`Type nesting over 60 levels at ${checker.typeToString(type)}`);
    const next = (inner) => serialize(inner, false, depth + 1);
    const flags = type.flags;
    if (flags & ts.TypeFlags.Any) return 'any';
    if (flags & ts.TypeFlags.Unknown) return 'unknown';
    if (flags & ts.TypeFlags.Never) return 'never';
    if (flags & ts.TypeFlags.Void) return 'void';
    if (flags & ts.TypeFlags.Undefined) return 'undefined';
    if (flags & ts.TypeFlags.Null) return 'null';
    if (flags & ts.TypeFlags.String) return 'string';
    if (flags & ts.TypeFlags.Number) return 'number';
    if (flags & ts.TypeFlags.BigInt) return 'bigint';
    if (flags & ts.TypeFlags.ESSymbolLike) return 'symbol';
    if (flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName;
    if (flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value);
    if (flags & ts.TypeFlags.NumberLiteral) return String(type.value);
    if (flags & ts.TypeFlags.BigIntLiteral) return `${type.value.negative ? '-' : ''}${type.value.base10Value}n`;
    if (flags & ts.TypeFlags.TypeParameter) return type.symbol?.name ?? 'T';
    if (flags & ts.TypeFlags.NonPrimitive) return 'object';

    if (!top) {
      const named = namedReference(type, next);
      if (named) return named;
    }

    if (flags & ts.TypeFlags.Conditional) {
      const { node } = type.root;
      return {
        conditional: [type.checkType, type.extendsType, checker.getTypeFromTypeNode(node.trueType),
          checker.getTypeFromTypeNode(node.falseType)].map(next),
      };
    }
    if (flags & ts.TypeFlags.IndexedAccess) return { indexed: [next(type.objectType), next(type.indexType)] };
    if (flags & ts.TypeFlags.Index) return { keyof: next(type.type) };
    if (flags & ts.TypeFlags.Substitution) return next(type.baseType);
    if (flags & (ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
      return `text:${checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)}`;
    }

    if (type.isUnion()) {
      const members = [...new Set(type.types.map(next).map((node) => JSON.stringify(node)))].map((text) => JSON.parse(text));
      const leaves = members.filter((node) => typeof node === 'string');
      const merged = BOOLEAN_PAIR.every((value) => leaves.includes(value))
        ? [...members.filter((node) => !BOOLEAN_PAIR.includes(node)), 'boolean']
        : members;
      return merged.length === 1 ? merged[0] : { union: merged.sort(byCanonical) };
    }
    if (checker.isArrayType(type)) return { array: next(checker.getTypeArguments(type)[0]) };
    if (checker.isTupleType(type)) {
      const target = type.target;
      return {
        tuple: checker.getTypeArguments(type).map((element, index) => {
          const flag = target.elementFlags?.[index] ?? 0;
          const node = next(element);
          return flag & ts.ElementFlags.Optional ? { optional: node } : flag & ts.ElementFlags.Rest ? { rest: node } : node;
        }),
      };
    }
    if (type.isIntersection() && type.types.some((member) => !(member.flags & ts.TypeFlags.Object))) {
      return { allOf: type.types.map(next).sort(byCanonical) };
    }
    if (type.isIntersection() || flags & ts.TypeFlags.Object) {
      if (type.getCallSignatures().length || type.getConstructSignatures().length) {
        return { fn: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation) };
      }
      const object = {};
      for (const property of checker.getPropertiesOfType(type)) {
        const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
        const propertyType = checker.getTypeOfSymbol(property);
        const name = property.name.startsWith('__@') ? checker.symbolToString(property) : property.name;
        object[optional ? `${name}?` : name] = next(optional ? withoutUndefined(propertyType) : propertyType);
      }
      const node = { object: sortKeys(object) };
      const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      if (stringIndex) node.index = next(stringIndex);
      else if (numberIndex) node.index = next(numberIndex);
      return node;
    }
    return `text:${checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)}`;
  }

  function withoutUndefined(type) {
    if (!type.isUnion()) return type;
    const kept = type.types.filter((member) => !(member.flags & ts.TypeFlags.Undefined));
    return kept.length === type.types.length ? type : checker.getUnionType(kept);
  }

  /** A reference to a named type: its definition goes into `types` the first time. Undefined for an anonymous type. */
  function namedReference(type, next) {
    const alias = type.aliasSymbol;
    if (alias) {
      const file = declarationFile(alias);
      if (file && !isLibFile(file)) return reference(alias, type.aliasTypeArguments ?? [], file, next);
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) return undefined;
    const symbol = type.symbol;
    const flags = type.flags;
    if (!symbol || !(flags & ts.TypeFlags.Object) || symbol.name.startsWith('__')) return undefined;
    if (!(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class))) return undefined;
    const file = declarationFile(symbol);
    if (!file) return undefined;
    const args = type.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(type) : [];
    if (isLibFile(file)) return args.length ? { ref: `lib:${symbol.name}`, args: args.map(next) } : `lib:${symbol.name}`;
    return reference(symbol, args, file, next);
  }

  function reference(symbol, args, file, next) {
    const pkg = packageOf(file.fileName);
    if (pkg) {
      externals.add(pkg);
      const name = `ext:${pkg}:${symbol.name}`;
      return args.length ? { ref: name, args: args.map(next) } : name;
    }
    const id = placeholder(symbol);
    if (!defs.has(id)) {
      defs.set(id, null);
      const declared = checker.getDeclaredTypeOfSymbol(symbol);
      defs.set(id, serialize(declared, true));
    }
    return args.length ? { ref: `#${id}`, args: args.map(next) } : `#${id}`;
  }

  function signatureOf(member, className) {
    const memberName = member.name.getText();
    const type = checker.getTypeAtLocation(member);
    const signatures = type.getCallSignatures();
    if (signatures.length !== 1) throw new Error(`${className}.${memberName} has ${signatures.length} call signatures; the RPC contract reads exactly one`);
    const [signature] = signatures;
    const params = signature.getParameters().map((parameter) => {
      const declaration = parameter.valueDeclaration;
      const entry = { name: parameter.name };
      if (declaration && ts.isParameter(declaration)) {
        if (declaration.dotDotDotToken) entry.rest = true;
        if (declaration.questionToken || declaration.initializer) entry.optional = true;
      }
      let parameterType = checker.getTypeOfSymbolAtLocation(parameter, member);
      if (entry.optional) parameterType = withoutUndefined(parameterType);
      entry.type = serialize(parameterType);
      return entry;
    });
    const returned = checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType();
    return { params, returns: serialize(returned) };
  }

  const isPublicMember = (member) => {
    if (!member.name || ts.isPrivateIdentifier(member.name)) return false;
    if (ts.isConstructorDeclaration(member)) return false;
    const modifiers = ts.getCombinedModifierFlags(member);
    return !(modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static));
  };

  const callable = (member) => ts.isMethodDeclaration(member)
    || (ts.isPropertyDeclaration(member) && checker.getTypeAtLocation(member).getCallSignatures().length > 0);

  const classes = {};
  const classRanges = [];
  for (const target of targets) {
    const methods = {};
    const chain = classChain(target.node);
    for (const node of chain) {
      classRanges.push({ node, file: node.getSourceFile(), pos: node.pos, end: node.end });
      for (const member of node.members) {
        if (!isPublicMember(member) || !callable(member)) continue;
        const name = member.name.getText().replace(/^['"]|['"]$/g, '');
        if (methods[name]) continue;
        methods[name] = signatureOf(member, target.name);
      }
    }
    const entry = { source: relative(target.file.fileName) };
    const base = target.base ?? (chain.length ? outsideBase(chain) : undefined);
    if (base) entry.base = base;
    entry.methods = sortKeys(methods);
    classes[target.name] = entry;
  }

  const payloads = {};
  for (const payload of payloadTypes) {
    const file = prog.getSourceFile(path.join(root, payload.source));
    const symbol = file && checker.getSymbolAtLocation(file)?.exports?.get(payload.name);
    if (!symbol) throw new Error(`Payload type ${payload.name} is not exported from ${payload.source}; update PAYLOADS in scripts/lib/rpc-surface.mjs`);
    payloads[payload.name] = { carries: payload.note, type: serialize(checker.getDeclaredTypeOfSymbol(symbol)) };
  }

  const sites = new Map();
  const fallbacks = new Set();
  const fallbackSymbol = (() => {
    const file = prog.getSourceFile(path.join(root, 'src/config/store-fallback.ts'));
    return file && checker.getSymbolAtLocation(file)?.exports?.get('withStoreFallback');
  })();
  const inClass = (file, pos) => classRanges.some((range) => range.file === file && pos >= range.pos && pos < range.end);
  const classNodesInChains = new Set(classRanges.map((range) => range.node));
  /**
   * A call reaches an object when its method resolves to one of the classes
   * above, or to a member of an interface or type literal in src (the stub
   * types callers hold). A method of another class, or of a library, does not.
   */
  const mayReachObject = (name) => {
    const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0];
    if (!declaration) return true;
    if (!isOwnSource(declaration.getSourceFile())) return false;
    if (ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration)) return true;
    return classNodesInChains.has(declaration.parent);
  };
  for (const file of srcFiles) {
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
        if (name && !inClass(file, node.pos) && mayReachObject(callee.name)) {
          const line = file.getLineAndCharacterOfPosition(callee.name.getStart(file)).line + 1;
          if (!sites.has(name)) sites.set(name, []);
          sites.get(name).push(`${relative(file.fileName)}:${line}`);
        }
        if (fallbackSymbol && ts.isIdentifier(callee) && resolve(checker.getSymbolAtLocation(callee)) === fallbackSymbol) {
          const [method] = node.arguments;
          if (method && ts.isStringLiteralLike(method)) fallbacks.add(method.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  for (const method of fallbacks) {
    const entry = classes[STATE_STORE_CLASS]?.methods[method];
    if (entry) entry.fallback = true;
  }

  const byName = new Map();
  for (const { symbol } of symbolNames.values()) {
    if (!byName.has(symbol.name)) byName.set(symbol.name, []);
    byName.get(symbol.name).push(symbol);
  }
  const finalName = new Map();
  for (const { id, symbol } of symbolNames.values()) {
    const shared = byName.get(symbol.name).length > 1;
    finalName.set(id, shared ? `${symbol.name}@${relative(declarationFile(symbol).fileName)}` : symbol.name);
  }
  const rename = (value) => JSON.parse(JSON.stringify(value).replace(/@@\d+@@/g, (id) => finalName.get(id)));
  const types = {};
  for (const [id, body] of defs) types[finalName.get(id)] = rename(body);

  const external = {};
  for (const pkg of [...externals].sort()) external[pkg] = versionOf(pkg) ?? 'unknown';

  return {
    surface: {
      schema: SURFACE_SCHEMA,
      classes: rename(classes),
      payloads: rename(payloads),
      external,
      types: sortKeys(types),
    },
    callersOf: (name) => sites.get(name) ?? [],
  };
}

export function canonical(node) {
  return typeof node === 'string' ? node : JSON.stringify(node);
}

function byCanonical(a, b) {
  const left = canonical(a);
  const right = canonical(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
