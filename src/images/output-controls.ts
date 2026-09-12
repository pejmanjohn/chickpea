/** Shared validation for the two configured GPT Image 2.5 models. */
export const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const IMAGE_BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const;
export type ImageQuality = typeof IMAGE_QUALITIES[number];
export type ImageBackground = typeof IMAGE_BACKGROUNDS[number];

export function validImageSize(value: string): boolean {
  if (value === 'auto') return true;
  const match = /^([1-9]\d{2,3})x([1-9]\d{2,3})$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width % 16 === 0 && height % 16 === 0 && width <= 3840 && height <= 3840 &&
    width / height >= 1 / 3 && width / height <= 3 &&
    width * height >= 655_360 && width * height <= 8_294_400;
}
