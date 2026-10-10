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
 * **`srcset` arrived with `/gallery` and is {@link imageSrcSet}** (MUSE-25). It was listed
 * here as deliberately absent until a page existed whose whole subject is photographs: one
 * width is defensible for a 160px logo and indefensible for a picture a visitor opens full
 * screen, and the ticket's own requirement is that a phone must not be sent a
 * full-resolution original. What that note asked for — *"measuring the real breakpoints
 * against real files"* — is what `src/lib/gallery.ts` records: the candidate widths and the
 * `sizes` expression live beside the grid they describe, and `test/gallery.test.ts`
 * measures the browser's selection against the painted box rather than modelling it.
 *
 * `imageSrc` stays, and callers with one box keep using it: the lockup, an event card and
 * an instructor portrait are each painted at one size, and a `srcset` there would mean the
 * performance budget measures a file almost nobody fetches (MUSE-64's argument, unchanged).
 *
 * What is still deliberately **not** here:
 *
 *   - A `<picture>` with an explicit `.webp`/`.jpg` pair. `auto=format` is the CDN
 *     negotiating the same thing from one URL (§9 rule 5), which is strictly less markup
 *     and no less correct.
 *   - LQIP / blur-up placeholders. `aspect-ratio` already reserves the box, so there is
 *     nothing to stop reflowing.
 *   - Density descriptors (`2x`). They answer the device and not the layout, so a tile that
 *     is 171px on a phone and 300px on a desktop cannot be described by them at all.
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
 * The pixel box the CDN serves — the whole asset, or what Mina's manual crop left of it.
 *
 * Sanity stores a crop as four fractional insets off the original and `rect` wants
 * pixels on the original, so this is the one conversion, in one place: `imageSrc` turns
 * it into the query parameter and `imageSize` measures it.
 */
function croppedPixels(
  asset: Asset,
  crop: ImageRef['crop'],
): { left: number; top: number; width: number; height: number } {
  if (!crop) return { left: 0, top: 0, width: asset.width, height: asset.height };
  const { top, bottom, left, right } = crop;
  return {
    left: Math.round(left * asset.width),
    top: Math.round(top * asset.height),
    width: Math.round((1 - left - right) * asset.width),
    height: Math.round((1 - top - bottom) * asset.height),
  };
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
    const box = croppedPixels(asset, ref.crop);
    params.push(`rect=${[box.left, box.top, box.width, box.height].join(',')}`);
  }

  params.push(`w=${Math.round(width)}`);
  // §9 rule 5, done by content negotiation rather than by a `<picture>` element.
  params.push('auto=format');
  params.push(`q=${QUALITY}`);

  return `${IMAGE_CDN}${path}?${params.join('&')}`;
}

/**
 * **The `srcset` for one photograph: the same URL at several widths** (MUSE-25).
 *
 * Width descriptors, not density descriptors, and paired with a `sizes` expression by the
 * caller. The browser then knows both how wide the box will be and which files exist, and
 * picks one — which is the only arrangement that can be right for a tile that is 171 CSS px
 * on a phone and 300 on a desktop.
 *
 * Three things this does and one it refuses:
 *
 *   - **Every candidate goes through `imageSrc`**, so the `rect` arithmetic, `auto=format`
 *     and the quality setting are decided in exactly one place. A second URL builder here
 *     is how a manual crop ends up applied at one width and not another.
 *   - **Widths wider than the asset are dropped, and the asset's own width is offered in
 *     their place.** The CDN will not invent detail, so a 1200px upload asked for `2000w`
 *     answers at 1200 — and a `2000w` descriptor on a 1200px file is a lie the browser
 *     believes: it will pick that candidate on a wide screen and get a smaller image than
 *     the one it rejected. {@link imageSize} already clamps, and this is the same clamp
 *     made visible in the descriptor.
 *   - **Duplicates collapse.** Two requested widths above a small asset both clamp to its
 *     width; emitting the same descriptor twice is invalid.
 *   - It refuses an **empty** width list rather than returning an empty attribute, because
 *     `srcset=""` is a `src` with no fallback behaviour anybody has reasoned about.
 */
export function imageSrcSet(ref: ImageRef, widths: readonly number[]): string {
  if (widths.length === 0) {
    throw new SanityContentError(
      'imageSrcSet was given no widths. A `srcset` with no candidates is not a narrower ' +
        'set of choices, it is an attribute the browser ignores — pass the widths the ' +
        'surface can paint (see GRID_WIDTHS / FULL_WIDTHS in src/lib/gallery.ts).',
    );
  }

  const available = croppedPixels(assetOf(ref), ref.crop).width;
  const offered = [...new Set(widths.map((width) => Math.min(Math.round(width), available)))];

  return offered
    .sort((a, b) => a - b)
    .map((width) => `${imageSrc(ref, { width })} ${width}w`)
    .join(', ');
}

/**
 * **The pixel size the CDN will actually answer `imageSrc` with** (MUSE-69).
 *
 * For a page this is unnecessary — the browser measures the file it fetched, and
 * `aspect-ratio` reserves the box before it arrives. For a **link preview** nothing
 * measures anything: Facebook's documentation is explicit that without `og:image:width`
 * and `og:image:height` the first share of a URL renders with no image at all, because
 * the card is laid out before the scraper has fetched the file. So the one consumer is
 * `src/lib/share-card.ts`, and what it needs is not "the size we asked for" but the size
 * the bytes will have.
 *
 * Hence the clamp. `width` is a request, and the CDN will not invent detail that is not
 * in the asset, so an upload narrower than the width asked for comes back at its own
 * width — and a declared size that disagrees with the file is worse than no declaration,
 * since a scraper that trusts it letterboxes or stretches the card. Pass the returned
 * `width` back into `imageSrc` and the two cannot disagree.
 *
 * The height follows from the **cropped** box, not the original: `rect` has already
 * trimmed the asset by the time a pixel is served.
 */
export function imageSize(
  ref: ImageRef,
  { width }: ImageSrcOptions,
): { width: number; height: number } {
  const box = croppedPixels(assetOf(ref), ref.crop);
  const served = Math.min(Math.round(width), box.width);
  return { width: served, height: Math.round((served * box.height) / box.width) };
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
