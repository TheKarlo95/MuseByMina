import { inflateSync } from 'node:zlib';

/**
 * **A PNG reader, in the suite, with no dependency** (MUSE-40).
 *
 * `test/icon.test.ts` has to look *inside* the committed icon files: the stroke weight
 * the small sizes carry is the one design judgement in that ticket, and an icon
 * regenerated without it is the right mark at the right size in the right colour and a
 * smudge — nothing about the file's name, path, size or declared `sizes` changes. Only
 * the pixels say so.
 *
 * The obvious tool is `sharp`, and it is already on disk: Astro's image service uses it
 * and `Lockup.astro` makes the build depend on it. It is still the wrong thing to import
 * here, because it is a **transitive and `optional`** dependency of `astro` — `npm ci
 * --omit=optional`, or a platform with no prebuilt binary, installs a tree where it is
 * simply absent. A suite that cannot run is indistinguishable from a suite that passes
 * on the day somebody checks, and declaring the phantom dependency to fix that would
 * pin this repository to a version of a library it does not otherwise use.
 *
 * So: `node:zlib` plus the PNG spec. Enough of it to read what the icons are, and no
 * more — see `decodeRgba`, which refuses anything it has not been taught rather than
 * returning plausible nonsense.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG colour types, as the spec numbers them. The two the icons use are named. */
export const COLOUR_TYPE = {
  /** Truecolour, three channels, no alpha — opaque by construction. */
  rgb: 2,
  /** Indexed colour. Opaque unless a `tRNS` chunk says otherwise. */
  palette: 3,
  /** Truecolour with alpha. What the transparent tab icons are. */
  rgba: 6,
} as const;

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
}

/** Every chunk in the file, in order, as `{ type, data }`. */
export function chunks(file: Buffer): { type: string; data: Buffer }[] {
  if (!file.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG: the 8-byte signature does not match');
  }

  const out: { type: string; data: Buffer }[] = [];
  let at = 8;

  while (at + 8 <= file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString('ascii', at + 4, at + 8);
    out.push({ type, data: file.subarray(at + 8, at + 8 + length) });
    // 4 length + 4 type + data + 4 CRC. The CRC is not checked: a corrupt file here
    // would fail every assertion that reads it anyway, loudly and with better words.
    at += 12 + length;
  }

  return out;
}

/** The `IHDR` fields. */
export function header(file: Buffer): PngHeader {
  const ihdr = chunks(file).find((chunk) => chunk.type === 'IHDR');
  if (ihdr === undefined) throw new Error('not a PNG: no IHDR chunk');

  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data.readUInt8(8),
    colourType: ihdr.data.readUInt8(9),
    interlace: ihdr.data.readUInt8(12),
  };
}

/** Does the file carry a `tRNS` chunk — the only way an indexed or truecolour PNG can
 *  be anything other than fully opaque. */
export function hasTransparencyChunk(file: Buffer): boolean {
  return chunks(file).some((chunk) => chunk.type === 'tRNS');
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * The pixels of an 8-bit RGBA PNG, as `width * height * 4` bytes.
 *
 * Throws on anything else — indexed colour, 16-bit samples, an interlaced file. The icons
 * this reads are written by one documented recipe (`logo/README.md`), so a file that is
 * not 8-bit RGBA is a file somebody regenerated with different settings, and that is
 * worth a failure rather than a silent reinterpretation.
 */
export function decodeRgba(file: Buffer): { header: PngHeader; pixels: Buffer } {
  const head = header(file);

  if (head.colourType !== COLOUR_TYPE.rgba || head.bitDepth !== 8) {
    throw new Error(
      `expected an 8-bit RGBA PNG (colour type ${COLOUR_TYPE.rgba}, depth 8), ` +
        `got colour type ${head.colourType} depth ${head.bitDepth}`,
    );
  }
  if (head.interlace !== 0) throw new Error('interlaced PNGs are not supported here');

  const idat = chunks(file)
    .filter((chunk) => chunk.type === 'IDAT')
    .map((chunk) => chunk.data);
  if (idat.length === 0) throw new Error('not a PNG image: no IDAT chunk');

  const raw = inflateSync(Buffer.concat(idat));

  const bpp = 4;
  const stride = head.width * bpp;
  const pixels = Buffer.alloc(head.height * stride);

  for (let y = 0; y < head.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x += 1) {
      const value = line[x]!;
      const a = x >= bpp ? out[x - bpp]! : 0;
      const b = prev?.[x] ?? 0;
      const c = x >= bpp ? (prev?.[x - bpp] ?? 0) : 0;

      let recovered: number;
      switch (filter) {
        case 0:
          recovered = value;
          break;
        case 1:
          recovered = value + a;
          break;
        case 2:
          recovered = value + b;
          break;
        case 3:
          recovered = value + ((a + b) >> 1);
          break;
        case 4:
          recovered = value + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filter} on row ${y}`);
      }

      out[x] = recovered & 0xff;
    }
  }

  return { header: head, pixels };
}

/** The alpha channel of an 8-bit RGBA PNG, one byte per pixel, row-major. */
export function alphaChannel(file: Buffer): Buffer {
  const { header: head, pixels } = decodeRgba(file);
  const alpha = Buffer.alloc(head.width * head.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = pixels[i * 4 + 3]!;
  return alpha;
}

/**
 * Mean alpha over the whole square, 0–1 — how much ink the icon carries.
 *
 * This is the instrument for the stroke-weight decision. It is a blunt one on purpose:
 * it cannot tell a well-shaped mark from a blob, which is what looking at the rendered
 * icon is for, but it is exactly sensitive to the failure that has no other symptom —
 * the plain crop, resampled straight down, with every hairline antialiased away.
 */
export function meanAlpha(file: Buffer): number {
  const alpha = alphaChannel(file);
  let total = 0;
  for (const value of alpha) total += value;
  return total / alpha.length / 255;
}

/** The distinct `#rrggbb` values among pixels with any alpha at all. */
export function inkColours(file: Buffer): Set<string> {
  const { pixels } = decodeRgba(file);
  const seen = new Set<string>();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    seen.add(
      `#${pixels[i]!.toString(16).padStart(2, '0')}` +
        `${pixels[i + 1]!.toString(16).padStart(2, '0')}` +
        `${pixels[i + 2]!.toString(16).padStart(2, '0')}`,
    );
  }
  return seen;
}
