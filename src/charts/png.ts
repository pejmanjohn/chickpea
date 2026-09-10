/**
 * Minimal indexed-colour PNG encoder. Charts use a handful of flat colours,
 * so an 8-bit palette image with unfiltered scanlines compresses well and
 * needs only the Web-standard `CompressionStream`, which both Node and the
 * Workers runtime provide. No image library is bundled into the Worker.
 */

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type RgbColor = readonly [number, number, number];

export interface IndexedImage {
  width: number;
  height: number;
  /** RGB entries; pixel values index into this table. At most 256 entries. */
  palette: readonly RgbColor[];
  /** Row-major palette indices, `width * height` entries. */
  pixels: Uint8Array;
}

export async function encodeIndexedPng(image: IndexedImage): Promise<Uint8Array> {
  const { width, height, palette, pixels } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('png dimensions must be positive integers');
  }
  if (palette.length < 1 || palette.length > 256) {
    throw new Error('png palette must hold 1 to 256 colours');
  }
  if (pixels.length !== width * height) {
    throw new Error('png pixel buffer does not match its dimensions');
  }

  const scanlines = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width + 1);
    scanlines[rowStart] = 0; // filter type: None
    scanlines.set(pixels.subarray(y * width, (y + 1) * width), rowStart + 1);
  }
  const compressed = new Uint8Array(await new Response(
    new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], index) => {
    plte[index * 3] = r;
    plte[index * 3 + 1] = g;
    plte[index * 3 + 2] = b;
  });

  return concatenate(
    PNG_SIGNATURE,
    chunk('IHDR', header(width, height)),
    chunk('PLTE', plte),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  );
}

function header(width: number, height: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = 3; // colour type: indexed
  data[10] = 0; // compression
  data[11] = 0; // filter method
  data[12] = 0; // no interlace
  return data;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(typeBytes, data));
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
