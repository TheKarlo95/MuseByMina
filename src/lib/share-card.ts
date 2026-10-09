/**
 * **The picture a shared link shows** (MUSE-69).
 *
 * Until this ticket `BaseLayout.astro` emitted `og:type`, `og:title`, `og:description`
 * and `og:url` and no image at all, so every link to this site pasted into a WhatsApp
 * group, an Instagram DM, a Facebook post, Slack or iMessage rendered as a bare line of
 * text. For a studio whose reach is almost entirely social that is the most-seen surface
 * the site has, and it was blank.
 *
 * The other half of the same defect: `siteSettings.shareImage` has existed end to end
 * since MUSE-20 — declared with `imageField()`, projected in `queries.ts`, decoded as an
 * `optionalImage`, present in the generated types — and **nothing read it**. Its Studio
 * description, the only instruction Mina ever sees, promised „Slika koju pokazuju
 * WhatsApp, Instagram i Facebook kad se link na stranicu podijeli." The build did not
 * keep that promise. `CLAUDE.md` names this failure by name: *a CMS field nothing
 * renders is worse than no field — it looks like it works*.
 *
 * ---------------------------------------------------------------------------------
 * ## The fallback, and why this one is allowed
 *
 * This repository is hostile to silent fallbacks and should stay that way. MUSE-49 made
 * a dangling reference **fatal** precisely so a blank could not pass as a value; MUSE-36
 * deleted thirteen invented classes; MUSE-60 found an invented founding date. The rule
 * those three share is not "never substitute" — it is **never assert something nobody
 * said**. A fallback bio, a fallback price, a fallback opening time each put a claim on
 * the page that no one at the studio has made, and the page gives the reader no way to
 * tell.
 *
 * A fallback to the studio's own mark asserts nothing beyond *this is Muse by Mina*,
 * which is true of every page on the site and is already said by the masthead, the
 * footer and the tab icon. There is no fact in it to be wrong about. So it is a
 * different kind of thing from the fallbacks this codebase refuses, and it is the one
 * shape of default that cannot mislead.
 *
 * The alternative — no `og:image` until a photograph exists — is not neutral either. A
 * scraper that finds no image caches that result, so the blank card outlives the upload
 * by however long the platform's cache runs.
 *
 * Two things keep it honest and both are load-bearing:
 *
 *   - **An upload wins, always.** `shareCard` reads `shareImage` first and only composes
 *     the brand card when the field is empty, so this never overrides Mina.
 *   - **The Studio says so.** `sanity/schemaTypes/documents/site.ts` tells her, in the
 *     field description, that leaving it empty shows the studio's logo and that
 *     uploading replaces it. A fallback the content editor does not know about is a
 *     fallback that looks like a bug.
 *
 * ---------------------------------------------------------------------------------
 * ## The brand card is §12 executed, not a new design
 *
 * MUSE-40 established the principle when it cropped the icon-only mark out of the
 * supplied lockup: **arranging supplied artwork according to the design system is not
 * inventing brand.** §12 specifies the lockup, the surfaces the white variant belongs
 * on, the clear space and the minimum size; the card is those four rules applied to a
 * 1200 × 630 frame and nothing else. No type was set, nothing was drawn, nothing was
 * traced. `test/share.test.ts` re-measures the committed file against
 * `src/assets/muse-lockup-white.png` every run rather than trusting this paragraph —
 * same instrument `test/lockup.test.ts` points at the masthead mark.
 *
 * The geometry is derived from `./lockup.ts`, which is where §12's two rules already
 * live, so there is no second copy of the cap-height fraction here. See
 * `SHARE_CARD_LOCKUP_WIDTH` for the one number that is a judgement.
 */

import type { Locale } from './i18n';
import { lockupClearSpace, lockupHeight } from './lockup';
import { SanityContentError, imageSize, imageSrc, type ImageRef } from './sanity';

/**
 * The composed card, imported rather than named as a path.
 *
 * `?url` for the reason every other asset here is imported — Vite emits the file with a
 * content hash and resolves the reference in a build and under `astro dev` alike, with
 * no base-path join anyone can get wrong (MUSE-35, MUSE-8).
 *
 * `no-inline` is not decoration. Vite base64-inlines an asset under its size threshold,
 * and a `data:` URI in `og:image` is a card no scraper on earth will render — it is not
 * a URL it can fetch, cache or re-fetch. The file is comfortably over the threshold
 * today, which is exactly why the flag has to be written down: the day somebody
 * re-exports it smaller, the tag would silently become a data URI and every assertion
 * about "the tag is present" would stay green.
 */
import brandCard from '../assets/muse-share-card.png?url&no-inline';

/** The frame every platform crops towards: 1200 × 630, Facebook's 1.91:1. */
export const SHARE_CARD = { width: 1200, height: 630 } as const;

/** The composed card's file, inside `src/assets/`. */
export const SHARE_CARD_FILE = 'muse-share-card.png';

/** The artwork it is composed from — the trimmed lockup, the only copy the build sees. */
export const SHARE_CARD_ARTWORK = 'src/assets/muse-lockup-white.png';

/**
 * The ground: §12's plum, opaque.
 *
 * Plum rather than the footer's plum-ink, because the card is not a band on a page — it
 * is the brand on its own, and §12's "all dark surfaces" entry for the white lockup is
 * satisfied by either. Plum is the colour the design system leads with (§13) and the one
 * `theme-color` already declares for the dark scheme.
 *
 * **Opaque, by construction.** A transparent share image is composited by each client
 * against whatever its chat bubble happens to be — white in a light chat, near-black in
 * a dark one — so a white lockup on transparency is invisible to half the audience. The
 * same argument makes the apple-touch tile opaque (`src/lib/icon.ts`), and for the same
 * reason: the surface belongs to somebody else's software.
 */
export const SHARE_CARD_GROUND = '#420535';

/**
 * **How wide the lockup is drawn on the card, in card pixels. The one judgement here.**
 *
 * §12's clear space is the cap height of „MUSE" on all four sides, which for this
 * artwork is `lockupClearSpace(width)` — so the envelope a lockup needs is about 1.207
 * times its width *tall*. The card is 630 tall, so §12 puts a ceiling on this number at
 * 521px and the width of the card never binds.
 *
 * 500 rather than 521, the same trade the masthead made at 36-rather-than-38
 * (`src/lib/icon.ts`): the 21 pixels are worth more as slack than as mark. They leave 13
 * pixels above and below the clear space, so the rule stays true with room rather than
 * exactly, and a future revision of either number cannot make it quietly false.
 *
 * It is also checked at the other end, which is the end that actually matters. A link
 * preview is not rendered at 1200px by anybody: WhatsApp paints it about 330 CSS pixels
 * wide in a chat, an iMessage rich link about 270 — the smallest of the real clients.
 * The card was rendered at both and looked at, and at 270 „DANCE STUDIO" and „BY MINA"
 * are still words rather than smears. The arithmetic agrees and says how little room
 * there is: 500 of 1200 is 112 CSS pixels at a 270px preview against §12's 100px
 * minimum, so 440 would be under the floor. This number has less headroom than its
 * modest share of the card suggests.
 */
export const SHARE_CARD_LOCKUP_WIDTH = 500;

/** The box the lockup occupies on the card — centred, derived, never retyped. */
export const SHARE_CARD_LOCKUP = {
  width: SHARE_CARD_LOCKUP_WIDTH,
  height: lockupHeight(SHARE_CARD_LOCKUP_WIDTH),
  left: Math.round((SHARE_CARD.width - SHARE_CARD_LOCKUP_WIDTH) / 2),
  top: Math.round((SHARE_CARD.height - lockupHeight(SHARE_CARD_LOCKUP_WIDTH)) / 2),
} as const;

/** §12's clear space at that size, in card pixels. The margin around the box is at least this. */
export const SHARE_CARD_CLEAR = lockupClearSpace(SHARE_CARD_LOCKUP_WIDTH);

/**
 * The width a `shareImage` upload is asked of the CDN at.
 *
 * The card's own width. Platforms downscale and re-encode whatever they are handed, so
 * there is nothing to win above it, and a 1200px JPEG of a photograph is a few tens of
 * kilobytes — far under WhatsApp's practical ceiling, which is nowhere near the 8 MB the
 * Open Graph spec allows.
 */
export const SHARE_IMAGE_WIDTH = SHARE_CARD.width;

/**
 * **The smallest upload that still renders as a card rather than as a thumbnail.**
 *
 * Facebook renders a large card above 600 × 315 and a small square thumbnail beside the
 * text below it; Twitter's `summary_large_image` floor is 300 × 157. 600 × 315 is
 * therefore the binding one, and it is the exact shape of failure this ticket exists to
 * stop — a declared image that technically resolves and visibly does not work.
 *
 * Below it the build **fails naming the document**, rather than quietly using the brand
 * card instead. Substituting would be the invisible failure: Mina uploaded something,
 * the site shows something else, and nothing anywhere says the upload was rejected.
 * Clearing the field is a legitimate fix and the message says so — the same call
 * `failDangling` makes in `src/lib/sanity/decode.ts` for an optional reference.
 */
export const SHARE_IMAGE_MIN = { width: 600, height: 315 } as const;

/**
 * The accessible description of the composed card.
 *
 * In code, not in Sanity, for the reason `src/lib/schedule.ts` keeps its copy in code:
 * this describes a file that is part of the build, so a CMS field for it could only ever
 * disagree with the artwork. An uploaded `shareImage` brings its own bilingual `alt`,
 * which `imageField()` already requires — that one *is* content, and it is read below.
 */
const BRAND_CARD_ALT: Record<Locale, string> = {
  hr: 'Logotip plesnog studija Muse by Mina, bijeli na šljiva podlozi.',
  en: 'The Muse by Mina dance studio logo, white on a plum background.',
};

/** What the layout needs in order to declare a card. */
export interface ShareCard {
  /**
   * The image's URL.
   *
   * Absolute already for an upload — Sanity's CDN is another origin — and a base-joined
   * path for the composed card, which the layout resolves against `Astro.site`. It is
   * deliberately **not** absolute here: this module has no business knowing the deploy
   * host, which lives in exactly one file (`astro.config.mjs`) so that a domain move is
   * a config change (MUSE-29).
   */
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Did this come from the Studio? Read by `test/share.test.ts`, never by the markup. */
  fromStudio: boolean;
}

/**
 * **The card for this page: Mina's upload if she has set one, the brand card if not.**
 *
 * One decision point, so "an upload wins" is a property of this function rather than of
 * whichever template happened to be written last.
 *
 * The upload is handed over at its own aspect ratio, trimmed by the manual crop if there
 * is one and nothing else — no server-side ratio crop. That is `src/lib/sanity/images.ts`'s
 * standing division of labour (the CDN is asked for one thing it cannot get wrong) and
 * here it is also the only correct answer: every platform crops a share image to its own
 * frame, and those frames disagree, so cropping to any one of them in advance is cropping
 * wrongly for the others. The cost, stated plainly: **the hotspot cannot be honoured** —
 * there is no browser in a link preview to do `object-fit`, so the platform crops from the
 * centre. A 16:9 upload loses about 7% of its height to a 1.91:1 frame, which is why the
 * field asks for 16:9 rather than something squarer.
 */
export function shareCard(shareImage: ImageRef | undefined, locale: Locale): ShareCard {
  if (shareImage === undefined) {
    return {
      src: brandCard,
      alt: BRAND_CARD_ALT[locale],
      width: SHARE_CARD.width,
      height: SHARE_CARD.height,
      fromStudio: false,
    };
  }

  const size = imageSize(shareImage, { width: SHARE_IMAGE_WIDTH });
  if (size.width < SHARE_IMAGE_MIN.width || size.height < SHARE_IMAGE_MIN.height) {
    throw new SanityContentError(
      `\`siteSettings.shareImage\` is ${size.width} × ${size.height}, which is below ` +
        `the ${SHARE_IMAGE_MIN.width} × ${SHARE_IMAGE_MIN.height} that Facebook and ` +
        `WhatsApp need before they draw a link preview as a card rather than as a small ` +
        `thumbnail beside the text. Asset: ${shareImage.assetId}. Upload a larger image ` +
        `— 1200 × 630 or bigger — or clear the field, which is a valid fix: the site ` +
        `then shows its own brand card.`,
    );
  }

  return {
    // The same width the size above was computed at, so the declared dimensions describe
    // the file the scraper is handed rather than the one we asked for. `imageSize` clamps
    // to what the asset can actually supply; asking the CDN for more would get this back
    // anyway, and a declared size that disagrees with the bytes is worse than none.
    src: imageSrc(shareImage, { width: size.width }),
    alt: shareImage.alt[locale],
    width: size.width,
    height: size.height,
    fromStudio: true,
  };
}

/**
 * **`og:locale`, and the one that is deliberately absent.**
 *
 * Open Graph spells a locale `language_TERRITORY`, so this is the hreflang tag the page
 * already declares with its separator swapped — one source for "what language is this",
 * shared with `<html lang>`, the canonical cluster and the sitemap. For Croatian that is
 * `hr_HR`; for English it is a bare `en`, because the hreflang cluster deliberately
 * claims no territory for English and inventing `en_US` here would be a second, more
 * specific answer to a question the rest of the site answers more carefully. A parser
 * that insists on a territory falls back to its own default, which costs nothing.
 *
 * **There is no `og:locale:alternate`, and that is a decision rather than an omission.**
 * It is not a hint; it is an instruction. Facebook's crawler responds to it by
 * re-requesting *the same URL* with `?fb_locale=<alternate>` and expecting the server to
 * answer in that language. This site is static, one document per route, with the locale
 * in the path — `/` serves Croatian to every request and the English twin lives at
 * `/en/`, chosen client-side (MUSE-48). So the refetch would get Croatian back and
 * Facebook would cache it as the English rendering of the page: a worse answer than
 * saying nothing. The hreflang cluster is where this site states the pairing, correctly,
 * to the crawlers that read paths rather than negotiate.
 */
export function ogLocale(htmlLang: string): string {
  return htmlLang.replace('-', '_');
}
