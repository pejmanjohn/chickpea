/**
 * The keys browser_act can press: named keys, their common aliases, and any
 * single character.
 */
const KEY_DEFINITIONS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter', enter: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', space: 'Space', ' ': 'Space', arrowup: 'ArrowUp', up: 'ArrowUp',
  arrowdown: 'ArrowDown', down: 'ArrowDown', arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight',
  right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};

// The message never names the key asked for: an approved step's key is replayed
// in a later turn, which could not redact a typed secret in it.
const UNSUPPORTED_KEY_MESSAGE = `Unsupported key. Use a single character or one of: ${Object.keys(KEY_DEFINITIONS).join(', ')}`;

/** The key events for `name`; throws for a key the browser cannot press. */
export function keyDefinition(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const canonical = KEY_DEFINITIONS[name] ? name : KEY_ALIASES[name.toLowerCase()];
  const known = canonical ? KEY_DEFINITIONS[canonical] : undefined;
  if (known) return known;
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(name);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: name,
    };
  }
  throw new Error(UNSUPPORTED_KEY_MESSAGE);
}
