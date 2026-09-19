import type { MemoryImage } from 'image-in-browser/lib/src/image/image.js';
import type { ImageOutputFormat } from './openai-images-client.ts';

// The codecs are ~1 MB of the Worker bundle and only image turns use them, so
// they load on first use instead of at Worker startup.
type ImageCodecs = {
  PngDecoder: typeof import('image-in-browser/lib/src/formats/png-decoder.js').PngDecoder;
  JpegDecoder: typeof import('image-in-browser/lib/src/formats/jpeg-decoder.js').JpegDecoder;
  WebPDecoder: typeof import('image-in-browser/lib/src/formats/webp-decoder.js').WebPDecoder;
  PngEncoder: typeof import('image-in-browser/lib/src/formats/png-encoder.js').PngEncoder;
  PngColorType: typeof import('image-in-browser/lib/src/formats/png/png-color-type.js').PngColorType;
  JpegEncoder: typeof import('image-in-browser/lib/src/formats/jpeg-encoder.js').JpegEncoder;
  Transform: typeof import('image-in-browser/lib/src/transform/transform.js').Transform;
  MemoryImage: typeof import('image-in-browser/lib/src/image/image.js').MemoryImage;
};
let codecsPromise: Promise<ImageCodecs> | undefined;
function imageCodecs(): Promise<ImageCodecs> {
  codecsPromise ??= (async () => {
    const [png, jpeg, webp, pngEncoder, pngColorType, jpegEncoder, transform, image] = await Promise.all([
      import('image-in-browser/lib/src/formats/png-decoder.js'),
      import('image-in-browser/lib/src/formats/jpeg-decoder.js'),
      import('image-in-browser/lib/src/formats/webp-decoder.js'),
      import('image-in-browser/lib/src/formats/png-encoder.js'),
      import('image-in-browser/lib/src/formats/png/png-color-type.js'),
      import('image-in-browser/lib/src/formats/jpeg-encoder.js'),
      import('image-in-browser/lib/src/transform/transform.js'),
      import('image-in-browser/lib/src/image/image.js'),
    ]);
    return {
      PngDecoder: png.PngDecoder, JpegDecoder: jpeg.JpegDecoder, WebPDecoder: webp.WebPDecoder,
      PngEncoder: pngEncoder.PngEncoder, PngColorType: pngColorType.PngColorType,
      JpegEncoder: jpegEncoder.JpegEncoder, Transform: transform.Transform, MemoryImage: image.MemoryImage,
    };
  })();
  return codecsPromise;
}

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
export async function decodeGeneratedImage(bytes: Uint8Array): Promise<{ image: MemoryImage; facts: ImageFacts }> {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('image_byte_limit');
  const { PngDecoder, JpegDecoder, WebPDecoder } = await imageCodecs();
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
export async function prepareImageOutput(bytes: Uint8Array, maxBytes: number, preserveDimensions: boolean): Promise<PreparedImage> {
  const { image, facts } = await decodeGeneratedImage(bytes);
  const { Transform, PngEncoder, JpegEncoder } = await imageCodecs();
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
export async function prepareImageInspection(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('image_byte_limit');
  const { PngDecoder, PngColorType, WebPDecoder, MemoryImage, PngEncoder } = await imageCodecs();
  // Opaque references need no local pixel allocation. In particular, a phone
  // photo may exceed generated-output geometry while fitting the provider's
  // inspection byte limit. Do not send unresolved alpha through this shortcut.
  if (bytes[0] === 255 && bytes[1] === 216) return { bytes, mimeType: 'image/jpeg' };
  if (bytes[0] === 137 && bytes[1] === 80) {
    const info = new PngDecoder().startDecode(bytes);
    if (info && info.numFrames <= 1 && !info.transparency &&
        (info.colorType === PngColorType.grayscale || info.colorType === PngColorType.rgb || info.colorType === PngColorType.indexed)) {
      return { bytes, mimeType: 'image/png' };
    }
  } else if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF') {
    const info = new WebPDecoder().startDecode(bytes);
    if (info && info.numFrames <= 1 && !info.hasAlpha) return { bytes, mimeType: 'image/webp' };
  }
  const { image, facts } = await decodeGeneratedImage(bytes);
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
