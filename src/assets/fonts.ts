// Chickpea's type, served from its own public assets under the SIL Open Font
// License; each family's OFL.txt sits beside its files in assets/fonts/.

type FontFamily = 'Baloo 2' | 'Quicksand' | 'JetBrains Mono';
export type FontWeights = Readonly<Partial<Record<FontFamily, readonly number[]>>>;

const SCRIPT_RANGES = {
  'cyrillic-ext': 'U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  devanagari: 'U+0900-097F,U+1CD0-1CF4,U+1CF7-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF,U+11B00-11B0A',
  vietnamese: 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
} as const;

type Script = keyof typeof SCRIPT_RANGES;
interface FontFile { path: string; range?: string }

const byScript = (dir: string, scripts: readonly Script[]): FontFile[] =>
  scripts.map((script) => ({ path: `fonts/${dir}/${script}.woff2`, range: SCRIPT_RANGES[script] }));

// Split by script, a page downloads only the scripts its text uses. Latin
// comes last: where ranges overlap, the face declared last wins. Quicksand
// ships whole, only compressed: its licence reserves the name, which a split
// (modified) file could not keep.
const FONT_FILES: Readonly<Record<FontFamily, readonly FontFile[]>> = {
  'Baloo 2': byScript('baloo-2', ['devanagari', 'vietnamese', 'latin-ext', 'latin']),
  Quicksand: [{ path: 'fonts/quicksand/quicksand.woff2' }],
  'JetBrains Mono': byScript('jetbrains-mono', ['cyrillic-ext', 'cyrillic', 'greek', 'vietnamese', 'latin-ext', 'latin']),
};

export const FONT_ASSET_PATHS = Object.values(FONT_FILES).flatMap((files) => files.map(({ path }) => path));

/** The Slack journey pages: Baloo 2 headings and Quicksand text. */
export const JOURNEY_FONTS: FontWeights = { 'Baloo 2': [600, 700, 800], Quicksand: [500, 600, 700] };

/** Admin and the Slack app guide, which also set code in JetBrains Mono. */
export const ADMIN_FONTS: FontWeights = {
  'Baloo 2': [500, 600, 700, 800], Quicksand: [400, 500, 600, 700], 'JetBrains Mono': [400, 500],
};

/**
 * One face per weight rather than a weight range: text at a weight between
 * two faces (750) renders at the next face up (800), as it did when these
 * weights were chosen, not at 750 on the variable axis.
 */
export function fontFaceCss(weights: FontWeights): string {
  return Object.entries(weights).flatMap(([family, list]) => list.flatMap((weight) =>
    FONT_FILES[family as FontFamily].map(({ path, range }) =>
      `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;` +
      `src:url(/${path}) format("woff2")${range ? `;unicode-range:${range}` : ''}}`))).join('\n');
}
