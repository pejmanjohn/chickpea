import { PngDecoder } from 'image-in-browser/lib/src/formats/png-decoder.js';
import { JpegDecoder } from 'image-in-browser/lib/src/formats/jpeg-decoder.js';
import { WebPDecoder } from 'image-in-browser/lib/src/formats/webp-decoder.js';
import { PngEncoder } from 'image-in-browser/lib/src/formats/png-encoder.js';
import { JpegEncoder } from 'image-in-browser/lib/src/formats/jpeg-encoder.js';
import { Transform } from 'image-in-browser/lib/src/transform/transform.js';
import { MemoryImage } from 'image-in-browser/lib/src/image/image.js';
import type { ImageOutputFormat } from './openai-images-client.ts';

export interface ImageFacts {
  width: number;
  height: number;
  transparent: boolean;
  format: ImageOutputFormat;
}
export interface PreparedImage extends ImageFacts {
  bytes: Uint8Array;
  compressed: boolean;
  resized: boolean;
}

/** Decode only bounded, single-frame provider outputs. Inspect actual pixels for transparency. */
export function decodeGeneratedImage(bytes: Uint8Array): { image: MemoryImage; facts: ImageFacts } {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('image_byte_limit');
  const format: ImageOutputFormat = bytes[0] === 137 && bytes[1] === 80 ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg'
    : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'webp'
    : (() => { throw new Error('invalid_image'); })();
  const decoder = format === 'png' ? new PngDecoder() : format === 'jpeg' ? new JpegDecoder() : new WebPDecoder();
  const info = decoder.startDecode(bytes);
  if (!info || info.width < 1 || info.height < 1 || info.width > 3840 || info.height > 3840 ||
      info.width * info.height > 8_294_400 || info.numFrames > 1) throw new Error('image_pixel_limit');
  const image = decoder.decodeFrame(0);
  if (!image) throw new Error('invalid_image');
  let transparent = false;
  if (image.hasAlpha) for (const pixel of image) {
    if (pixel.a < pixel.maxChannelValue) { transparent = true; break; }
  }
  return { image, facts: { width: image.width, height: image.height, transparent, format } };
}

/** Re-encode retained bytes without another provider call. Explicit dimensions are never reduced. */
export function prepareImageOutput(bytes: Uint8Array, maxBytes: number, preserveDimensions: boolean): PreparedImage {
  const { image, facts } = decodeGeneratedImage(bytes);
  if (bytes.length <= maxBytes) return { ...facts, bytes, compressed: false, resized: false };
  let best: PreparedImage = { ...facts, bytes, compressed: false, resized: false };
  for (const scale of preserveDimensions ? [1] : [1, 0.75, 0.5]) {
    const resized = scale === 1 ? image : Transform.copyResize({ image, width: Math.max(1, Math.round(image.width * scale)) });
    for (const quality of facts.transparent ? [80] : [80, 55, 35]) {
      const encoded = facts.transparent
        ? new PngEncoder({ level: 6 }).encode({ image: resized, singleFrame: true, skipExif: true })
        : new JpegEncoder(quality).encode({ image: resized, skipExif: true });
      if (encoded.length < best.bytes.length) best = {
        width: resized.width, height: resized.height, transparent: facts.transparent,
        format: facts.transparent ? 'png' : 'jpeg', bytes: encoded, compressed: true, resized: scale !== 1,
      };
      if (best.bytes.length <= maxBytes) return best;
    }
  }
  return best;
}

/** Vision adapters may discard alpha instead of compositing it. Show only
 * visible pixels against a neutral checkerboard, without changing the file
 * retained or delivered to the user. Work on one bounded decoded image at a time.
 */
export function prepareImageInspection(bytes: Uint8Array): { bytes: Uint8Array; mimeType: string } {
  const { image, facts } = decodeGeneratedImage(bytes);
  if (!facts.transparent) return { bytes, mimeType: `image/${facts.format}` };
  const preview = new MemoryImage({ width: image.width, height: image.height, numChannels: 3 });
  for (const pixel of image) {
    const alpha = pixel.a / pixel.maxChannelValue;
    const matte = (Math.floor(pixel.x / 32) + Math.floor(pixel.y / 32)) % 2 ? 224 : 248;
    const blend = (channel: number) => Math.round(channel / pixel.maxChannelValue * 255 * alpha + matte * (1 - alpha));
    preview.setPixelRgb(pixel.x, pixel.y, blend(pixel.r), blend(pixel.g), blend(pixel.b));
  }
  return { bytes: new PngEncoder({ level: 6 }).encode({ image: preview, singleFrame: true, skipExif: true }), mimeType: 'image/png' };
}
