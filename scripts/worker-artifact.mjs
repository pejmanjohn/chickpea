import ts from 'typescript';

// Inspect the wiring, not local identifier spellings or whitespace. Minifiers
// may rename both handlers, but must preserve these public property/method keys.
export function hasScheduledComposition(source) {
  const file = ts.createSourceFile('worker.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) return false;
  const functions = new Map(file.statements
    .filter(ts.isFunctionDeclaration)
    .filter((node) => node.name && node.body)
    .map((node) => [node.name.text, node]));
  // Follow only direct identifier calls reachable from the selected handler;
  // do not let an unrelated function elsewhere in the entry satisfy the check.
  const callsMethod = (handler, name, seen = new Set()) => {
    if (!handler?.body || seen.has(handler)) return false;
    seen.add(handler);
    const scan = (node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === name) return true;
        if (ts.isIdentifier(node.expression)) {
          const delegate = functions.get(node.expression.text);
          if (delegate && callsMethod(delegate, name, seen)) return true;
        }
      }
      return Boolean(ts.forEachChild(node, (child) => scan(child) || undefined));
    };
    return scan(handler.body);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        const handlers = new Map(arg.properties
          .filter(ts.isPropertyAssignment)
          .filter((property) => ts.isIdentifier(property.name) && ts.isIdentifier(property.initializer))
          .map((property) => [property.name.text, functions.get(property.initializer.text)]));
        const heartbeat = handlers.get('heartbeat');
        const maintenance = handlers.get('maintenance');
        if (heartbeat && maintenance &&
            callsMethod(heartbeat, 'heartbeat') && callsMethod(maintenance, 'maintainWork')) return true;
      }
    }
    return Boolean(ts.forEachChild(node, (child) => visit(child) || undefined));
  };
  return visit(file);
}
