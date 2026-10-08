import { sanitySource } from './client';
import { SanityContentError, type ImageRef } from './decode';

/**
 * **Turning an `ImageRef` into something an `<img>` can use.**
 *
 * `./decode.ts` deliberately hands a page the asset id, the hotspot and the crop rather
 * than a URL, because the ratio is the page's decision: one upload serves 16:9, 4:5, 3:4
 * and 1:1 (design system §9 rule 4). This module is the other half of that — the smallest
 * thing that resolves the ref *at the point of use*, per ratio, and nothing more.
 *
 * ---------------------------------------------------------------------------------
 * **The design decision worth defending: the ratio is cropped by CSS, not by the CDN.**
 *
 * The obvious implementation asks Sanity's image API for the final 3:4 crop —
 * `?w=600&h=800&fit=crop&crop=focalpoint&fp-x=…&fp-y=…` — and gets a correctly framed
 * image back. It also needs the focal point expressed relative to any manual crop *and*
 * composed with `rect`, and the two interact: `rect` changes the coordinate space `fp-x`
 * is measured in. Getting that wrong produces a wrongly framed photograph, with no error
 * anywhere, and there is no photograph in this dataset to check it against — the studio
 * has not been shot yet (MUSE-23). A silent, unverifiable failure is exactly the class of
 * bug the rest of this directory exists to prevent.
 *
 * So the division of labour is the one §9 rule 2 already states: *"`object-fit: cover`
 * with an explicit `aspect-ratio`"*. The CDN is asked for one thing it cannot get wrong —
 * the image, at a width, trimmed by the manual crop if there is one — and the browser does
 * the ratio crop, centred on the hotspot via `object-position`. Every piece is then
 * separately checkable: `rect` is pixel arithmetic on the source dimensions, and
 * `object-position` is a percentage.
 *
 * What is deliberately **not** here, and should be its own ticket once photographs exist:
 *
 *   - `srcset`/`sizes`. One width is served. A portrait is at most ~420px wide in this
 *     layout, so `w=600` covers 1x comfortably and under-serves a 2x screen; fixing that
 *     properly means measuring the real breakpoints against real files.
 *   - A `<picture>` with an explicit `.webp`/`.jpg` pair. `auto=format` is the CDN
 *     negotiating the same thing from one URL (§9 rule 5), which is strictly less markup
 *     and no less correct.
 *   - LQIP / blur-up placeholders. `aspect-ratio` already reserves the box, so there is
 *     nothing to stop reflowing.
 * ---------------------------------------------------------------------------------
 */

/** `image-<assetHash>-<width>x<height>-<extension>`, which is how Sanity names an asset. */
const ASSET_ID = /^image-([a-zA-Z0-9]+)-(\d+)x(\d+)-(\w+)$/;

/** Sanity's image CDN. Not the deploy host, which lives only in `astro.config.mjs`. */
const IMAGE_CDN = 'https://cdn.sanity.io';

/** JPEG quality. 80 is the point where the saving stops being free on warm, low-lit photography. */
const QUALITY = 80;

interface Asset {
  hash: string;
  width: number;
  height: number;
  extension: string;
}

/**
 * The parts of an asset id, or a build failure naming it.
 *
 * Loud rather than lenient. An unparseable id built into a URL anyway is an `<img>`
 * pointing at a 404 — a blank frame, no error, which is the MUSE-49 shape of failure — and
 * the only way to get one here is a projection that handed us something that is not an
 * image asset.
 */
function assetOf(ref: ImageRef): Asset {
  const match = ASSET_ID.exec(ref.assetId);
  if (!match) {
    throw new SanityContentError(
      `"${ref.assetId}" is not a Sanity image asset id. They are shaped ` +
        `\`image-<id>-<width>x<height>-<ext>\`, and the width and height are what the ` +
        `crop arithmetic in src/lib/sanity/images.ts needs. A \`file-…\` id here means an ` +
        `image field is pointing at an upload that is not an image.`,
    );
  }
  return {
    hash: match[1]!,
    width: Number(match[2]),
    height: Number(match[3]),
    extension: match[4]!,
  };
}

export interface ImageSrcOptions {
  /** Pixel width to ask the CDN for. The ratio crop is CSS's job — see the note above. */
  width: number;
}

/**
 * The URL to put in `src`.
 *
 * `rect` is applied when — and only when — Mina has dragged the crop handles. Sanity
 * stores a crop as four fractional insets off the original, and `rect` wants pixels on the
 * original, so this is the one conversion: `left × W`, `top × H`, and what is left over.
 */
export function imageSrc(ref: ImageRef, { width }: ImageSrcOptions): string {
  const asset = assetOf(ref);
  const { projectId, dataset } = sanitySource();
  const path =
    `/images/${projectId}/${dataset}/` +
    `${asset.hash}-${asset.width}x${asset.height}.${asset.extension}`;

  /**
   * The query is assembled by hand rather than with `URLSearchParams`, for one reason:
   * `URLSearchParams` percent-encodes the commas in `rect`, and while `%2C` is equivalent
   * after decoding, `rect=432,225,720,441` is the spelling Sanity's own URL builder emits
   * and the spelling their documentation shows. There is no photograph in this dataset to
   * check the encoded form against (MUSE-23), so the canonical spelling is the one to
   * publish. Every value here is a number or a fixed keyword, so there is nothing to
   * escape.
   */
  const params: string[] = [];

  if (ref.crop) {
    const { top, bottom, left, right } = ref.crop;
    const rect = [
      Math.round(left * asset.width),
      Math.round(top * asset.height),
      Math.round((1 - left - right) * asset.width),
      Math.round((1 - top - bottom) * asset.height),
    ];
    params.push(`rect=${rect.join(',')}`);
  }

  params.push(`w=${Math.round(width)}`);
  // §9 rule 5, done by content negotiation rather than by a `<picture>` element.
  params.push('auto=format');
  params.push(`q=${QUALITY}`);

  return `${IMAGE_CDN}${path}?${params.join('&')}`;
}

/** Where the subject is, as the two percentages `object-position` takes. */
export interface ImageFocus {
  x: number;
  y: number;
}

/**
 * The hotspot, as an `object-position` for the cropped image the browser receives.
 *
 * Three things this has to get right, each of which is a different silent failure:
 *
 *   - **No hotspot means the centre.** Absent is the ordinary state — Sanity only writes
 *     one once it has been dragged — and `0% 0%` would top-left-align every portrait on
 *     the page. 50/50 is also what Sanity's own centre-crop does, so the two agree.
 *   - **A hotspot is a fraction of the *original*, and `rect` has already trimmed the
 *     original.** So inside a crop the hotspot is re-based onto the remaining frame; using
 *     the raw value would pull the focus towards whichever edge was cropped.
 *   - **Clamped.** A hotspot can legitimately sit outside a crop Mina set afterwards, and
 *     `object-position: -13%` is not an error — it just shifts the image off its own frame.
 *     The nearest edge is the honest answer.
 *
 * `hotspot.width`/`height` are ignored on purpose: they describe the *region* Sanity would
 * try to keep whole, which only means something to a server-side crop. A `cover` crop can
 * honour a point, not an area.
 */
export function imageFocus(ref: ImageRef): ImageFocus {
  if (!ref.hotspot) return { x: 50, y: 50 };

  const { left = 0, right = 0, top = 0, bottom = 0 } = ref.crop ?? {};
  const horizontal = 1 - left - right;
  const vertical = 1 - top - bottom;

  return {
    x: percent(horizontal > 0 ? (ref.hotspot.x - left) / horizontal : ref.hotspot.x),
    y: percent(vertical > 0 ? (ref.hotspot.y - top) / vertical : ref.hotspot.y),
  };
}

/** A 0–1 fraction as a 0–100 percentage, clamped, rounded to two places. */
function percent(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * 10_000) / 100;
}
