import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_COPY, type FormCopy } from '../src/lib/forms';
import type { Locale } from '../src/lib/i18n';
import { startPreview, type Preview, type StubReply } from './helpers/preview';

/**
 * MUSE-15 — the two defects on the conversion path that setting the endpoint does not fix.
 *
 * **D1.** The failure block rendered `Error.message` verbatim, so a Croatian visitor read
 * three good localised sentences and then `PUBLIC_FORM_ENDPOINT is not configured`, or
 * `HTTP 500 Internal Server Error` once an endpoint existed. The only English-only
 * user-facing string on the site.
 *
 * **D2.** The form was `method="post"` with no `action`, so without JavaScript it posted
 * to the page itself and a static host answered `405 Not Allowed` — input lost, visitor
 * gone — while the `<noscript>` text claimed a confirmation would appear on the form
 * service's own page.
 *
 * Both are driven here rather than reasoned about: real failures through the stub
 * endpoint in `helpers/preview.ts`, a real offline browser context, a real build with no
 * endpoint configured (which is how `main` ships today, MUSE-12 being parked), and a
 * real browser with JavaScript actually disabled.
 *
 * The guard that matters is D1's third criterion — *a test fails if any rendered failure
 * state contains an untranslated diagnostic*. It is written below as a property over the
 * failure modes, not as a search for today's two strings: see `residue`.
 */

interface Target {
  locale: Locale;
  contact: string;
  home: string;
  copy: FormCopy;
  /** The other locale's copy — used to prove a page is not serving both. */
  other: FormCopy;
}

const TARGETS: Target[] = [
  { locale: 'hr', contact: '/contact', home: '/', copy: FORM_COPY.hr, other: FORM_COPY.en },
  { locale: 'en', contact: '/en/contact', home: '/en', copy: FORM_COPY.en, other: FORM_COPY.hr },
];

const FORM = '[data-trial-form]';
const VALID = {
  name: 'Ana Horvat',
  email: 'ana.horvat@example.com',
  phone: '+385 91 234 5678',
  level: 'pocetni',
  message: 'Dolazim s prijateljicom, obje smo početnice.',
} as const;

let browser: Browser;
/** Built with the stub endpoint: every HTTP failure mode is reachable. */
let configured: Preview;
/** Built with no endpoint at all — exactly what `main` deploys today. */
let unconfigured: Preview;

beforeAll(async () => {
  [configured, unconfigured, browser] = await Promise.all([
    startPreview('trialform'),
    startPreview('trialform-noendpoint', { endpoint: '' }),
    chromium.launch(),
  ]);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all([configured?.close(), unconfigured?.close()]);
});

interface Visit {
  page: Page;
  url: string;
  /** Everything the page logged, in order, newest last. */
  console: { type: string; text: string }[];
  /** The status of every document the browser navigated to, including the first. */
  navigations: number[];
  offline(on: boolean): Promise<void>;
  close(): Promise<void>;
}

async function visit(
  preview: Preview,
  route: string,
  opts: { javaScript?: boolean } = {},
): Promise<Visit> {
  const ctx = await browser.newContext({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 900 },
    // `src/lib/lang.ts` redirects a browser that is clearly not Croatian away from `/`.
    // Without pinning the language, every assertion about `/` is one about `/en`.
    locale: route.startsWith('/en') ? 'en-GB' : 'hr-HR',
    javaScriptEnabled: opts.javaScript ?? true,
  });
  const page = await ctx.newPage();
  const logged: { type: string; text: string }[] = [];
  page.on('console', (msg) => logged.push({ type: msg.type(), text: msg.text() }));
  const navigations: number[] = [];
  page.on('response', (response) => {
    if (response.request().isNavigationRequest()) navigations.push(response.status());
  });
  const url = preview.url(route);
  await page.goto(url, { waitUntil: 'networkidle' });
  return {
    page,
    url,
    console: logged,
    navigations,
    offline: (on) => ctx.setOffline(on),
    close: () => ctx.close(),
  };
}

async function fillForm(page: Page): Promise<void> {
  await page.fill(`${FORM} [name="name"]`, VALID.name);
  await page.fill(`${FORM} [name="email"]`, VALID.email);
  await page.fill(`${FORM} [name="phone"]`, VALID.phone);
  await page.selectOption(`${FORM} [name="level"]`, VALID.level);
  await page.fill(`${FORM} [name="message"]`, VALID.message);
}

/** One line of text, NFC-normalised, so a comparison is about words and not spacing. */
function flatten(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Every leaf string the copy table declares, in any locale, longest first. */
function phrases(copy: FormCopy): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(flatten(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(copy);
  // The blank "not sure yet" option value, and anything else too short to subtract
  // without chewing into the text it is being subtracted from.
  return out.filter((phrase) => phrase.length >= 3).sort((a, b) => b.length - a.length);
}

/**
 * What is left of `rendered` once every word the site actually wrote has been removed.
 *
 * This is AC3, and the reason it is phrased this way round. A test that looked for
 * `PUBLIC_FORM_ENDPOINT`, or for `/^HTTP \d{3}/`, passes the moment the next diagnostic
 * is worded differently — and a string allow-list is the defect class this repo has
 * re-filed five times (MUSE-37, MUSE-42, MUSE-46, MUSE-50, and the deploy-host check).
 * So the question asked here is the inverse one: **is every character the visitor can
 * read something we wrote, in their language?** Anything else — a variable name, an HTTP
 * status, an exception message, a provider's error body, a string somebody forgets to
 * translate next year — survives the subtraction and fails the assertion by existing.
 *
 * `extras` are the things on the page that are legitimately not copy: the studio's email
 * address, which is content, and whatever the visitor typed themselves.
 */
function residue(rendered: string, copy: FormCopy, extras: string[]): string {
  // Case-folded, because the labels and the submit are uppercased by `text-transform`
  // (§7.2) and `innerText` reports what is painted: the copy table says "Full name" and
  // the visitor reads "FULL NAME". Nothing is lost — a diagnostic that differed from our
  // own copy only in capitalisation would be our own copy.
  let left = flatten(rendered).toLowerCase();
  for (const phrase of phrases(copy)) left = left.split(phrase.toLowerCase()).join(' ');
  for (const extra of extras) left = left.split(flatten(extra).toLowerCase()).join(' ');
  // Punctuation and whitespace carry no language, so they are not residue. Letters,
  // digits and `_` are: `HTTP 500`, `PUBLIC_FORM_ENDPOINT`, `TypeError` all survive.
  return left.replace(/[^\p{L}\p{N}_]+/gu, '');
}

interface Failure {
  label: string;
  /** Which build drives it: the stub endpoint, or no endpoint at all. */
  build: 'stub' | 'none';
  reply?: StubReply;
  /** Take the whole browser context offline before submitting. */
  offline?: boolean;
  /** Which localised line the visitor should get. */
  explains: 'generic' | 'offline';
}

/**
 * The failure modes a visitor can actually reach, every one of them driven for real.
 *
 * The statuses are varied rather than enumerated in copy: the point is that the *number*
 * never reaches the page, so the suite submits several and asserts the same rendering.
 */
const FAILURES: Failure[] = [
  {
    label: 'no endpoint is configured',
    build: 'none',
    explains: 'generic',
  },
  {
    label: 'the provider rejects the submission (400)',
    build: 'stub',
    reply: { kind: 'error', status: 400 },
    explains: 'generic',
  },
  {
    label: 'the endpoint is gone (404)',
    build: 'stub',
    reply: { kind: 'error', status: 404 },
    explains: 'generic',
  },
  {
    label: 'the provider rate-limits us (429)',
    build: 'stub',
    reply: { kind: 'error', status: 429 },
    explains: 'generic',
  },
  {
    label: 'the provider breaks and returns its own error page (500)',
    build: 'stub',
    reply: { kind: 'error', status: 500, body: '<h1>Internal Server Error</h1>' },
    explains: 'generic',
  },
  {
    label: 'the provider is unavailable (503)',
    build: 'stub',
    reply: { kind: 'error', status: 503 },
    explains: 'generic',
  },
  {
    label: 'the connection drops mid-request',
    build: 'stub',
    reply: { kind: 'drop' },
    explains: 'generic',
  },
  {
    label: 'the visitor is offline',
    build: 'stub',
    offline: true,
    explains: 'offline',
  },
];

/** Submit the filled form and wait for the failure block, returning what it renders. */
interface Failed {
  /** What `[data-form-status]` renders, as the visitor reads it. */
  status: string;
  /** The same for the whole form block, so a diagnostic cannot just move elements. */
  wrap: string;
  console: Visit['console'];
  /** The studio address, read off the page rather than hard-coded — it is content. */
  email: string;
  /** True if the submit took the visitor off the page it was on. */
  navigated: boolean;
}

async function failOnce(failure: Failure, target: Target): Promise<Failed> {
  const preview = failure.build === 'none' ? unconfigured : configured;
  if (failure.reply) preview.reply(failure.reply);
  const seen = await visit(preview, target.contact);
  try {
    await fillForm(seen.page);
    const mail = seen.page.locator('[data-form-wrap] a[href^="mailto:"]').first();
    const email = (await mail.getAttribute('href')) ?? '';
    if (failure.offline) await seen.offline(true);
    await seen.page.click('[data-submit]');
    await seen.page.waitForSelector('[data-form-status]:not([hidden])', { timeout: 15_000 });
    return {
      status: await seen.page.locator('[data-form-status]').innerText(),
      wrap: await seen.page.locator('[data-form-wrap]').innerText(),
      console: [...seen.console],
      email: email.replace(/^mailto:/, ''),
      navigated: seen.page.url() !== seen.url,
    };
  } finally {
    if (failure.offline) await seen.offline(false);
    await seen.close();
  }
}

/**
 * D1, AC1 and AC3 — given any submission failure in either locale, the visitor sees a
 * localised explanation and no raw `Error.message`, variable name, or HTTP status text.
 */
describe('D1: a failed submit says only things the site wrote, in the visitor’s language', () => {
  for (const target of TARGETS) {
    for (const failure of FAILURES) {
      it(`${target.locale}: ${failure.label} — nothing untranslated is rendered`, async () => {
        const seen = await failOnce(failure, target);

        // The failure block, character by character, is the site's own copy plus the
        // studio address. Whatever is left over is a diagnostic that leaked.
        expect(
          residue(seen.status, target.copy, [seen.email]),
          `the failure block rendered text the copy table does not declare: ${flatten(seen.status)}`,
        ).toBe('');

        // And the form block around it, so a diagnostic cannot simply move one element out.
        expect(
          residue(seen.wrap, target.copy, [seen.email, ...Object.values(VALID)]),
          `the form block rendered text the copy table does not declare: ${flatten(seen.wrap)}`,
        ).toBe('');

        // It is still an explanation, not a blank box, and it is in one language.
        expect(flatten(seen.status)).toContain(flatten(target.copy.failTitle));
        expect(flatten(seen.status), 'failed in the wrong language').not.toContain(
          flatten(target.other.failTitle),
        );
        expect(seen.navigated, 'the page navigated away').toBe(false);
      });
    }

    /**
     * The ticket's own direction: separate causes the visitor can act on from the ones
     * they cannot. `navigator.onLine === false` is the only signal that reliably means
     * "your network is down" — a fetch `TypeError` also covers CORS and a dead
     * provider, neither of which is anything the visitor can do something about.
     */
    it(`${target.locale}: being offline is explained as something to act on`, async () => {
      const offline = FAILURES.find((f) => f.offline)!;
      const seen = await failOnce(offline, target);
      expect(flatten(seen.status)).toContain(flatten(target.copy.failOffline));
      expect(flatten(seen.status)).not.toContain(flatten(target.copy.failBody));
    });

    it(`${target.locale}: a failure the visitor cannot act on gets one generic line`, async () => {
      const server = FAILURES.find((f) => f.reply?.kind === 'error')!;
      const seen = await failOnce(server, target);
      expect(flatten(seen.status)).toContain(flatten(target.copy.failBody));
      expect(flatten(seen.status)).not.toContain(flatten(target.copy.failOffline));
      // The way out that does not depend on the thing that just broke.
      expect(seen.email).toContain('@');
      expect(flatten(seen.status)).toContain(seen.email);
    });
  }

  /** D1, AC2 — the underlying error still reaches the console for debugging. */
  for (const failure of FAILURES) {
    it(`${failure.label} — the real error is still logged to the console`, async () => {
      const seen = await failOnce(failure, TARGETS[0]!);
      const errors = seen.console.filter((entry) => entry.type === 'error');
      expect(
        errors.length,
        `nothing was logged; the console saw ${JSON.stringify(seen.console)}`,
      ).toBeGreaterThan(0);
      // Something about *this* form, so the line is findable among a page's logs.
      expect(errors.map((e) => e.text).join('\n').toLowerCase()).toContain('form');
    });
  }
});

/**
 * D2 — submitting without JavaScript must not yield a 405, and no copy may promise
 * behaviour that does not happen.
 *
 * The chosen answer is the ticket's second option: the form is replaced by the honest
 * `mailto:` route, and native submission is made structurally impossible rather than
 * pointed at a provider whose non-AJAX behaviour nobody here can verify. See the PR.
 */
describe('D2: without JavaScript, the form is replaced by something that works', () => {
  const BUILDS = [
    { label: 'no endpoint configured', preview: () => unconfigured },
    { label: 'an endpoint configured', preview: () => configured },
  ];

  /**
   * The premise of the whole defect, pinned rather than remembered: the host this site
   * deploys to answers any POST with 405, whatever the path. So a form that can submit
   * natively to a page of the site is a 405 by construction.
   */
  for (const build of BUILDS) {
    it(`${build.label}: the host answers a native POST to the page with 405`, async () => {
      const preview = build.preview();
      const response = await fetch(preview.url('/contact'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=Ana',
        redirect: 'manual',
      });
      expect(response.status).toBe(405);
    });
  }

  for (const target of TARGETS) {
    for (const build of BUILDS) {
      it(`${target.locale}, ${build.label}: no form on the page declares a native submit to this host`, async () => {
        const preview = build.preview();
        for (const route of [target.contact, target.home]) {
          const html = await (await fetch(preview.url(route))).text();
          const forms = html.match(/<form\b[^>]*>/g) ?? [];
          expect(forms.length, `${route} renders no form at all`).toBeGreaterThan(0);

          for (const tag of forms) {
            const attr = (name: string): string | undefined =>
              new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
            const method = (attr('method') ?? 'get').toLowerCase();
            // An absent or empty action submits to the page itself.
            const action = new URL(attr('action') || preview.url(route), preview.url(route));
            const here = new URL(preview.url(route));

            // The property, rather than a check for today's markup: nothing on this
            // site may declare a native submission to the deploy origin. A POST is the
            // 405; a GET would put a name, an email and a phone number in a URL, in
            // history and in every log on the way. Once MUSE-12 lands, an `action` on
            // the provider's own origin is still free to exist.
            const nativeToUs =
              action.origin === here.origin && method !== 'dialog';
            expect(
              nativeToUs,
              `${route}: a form submits natively to this host (method=${method} action=${action.href})`,
            ).toBe(false);
          }
        }
      });

      it(`${target.locale}, ${build.label}: with JavaScript disabled, the inbox is offered and nothing can 405`, async () => {
        const preview = build.preview();
        const seen = await visit(preview, target.contact, { javaScript: false });
        try {
          // The enhanced form is not shown: it cannot be sent, so it is not offered.
          expect(
            await seen.page.locator(FORM).isVisible(),
            'the form that cannot be sent is still on display',
          ).toBe(false);

          // What replaces it names the studio inbox, as a link that works.
          const block = flatten((await seen.page.locator('[data-form-wrap]').innerText()) ?? '');
          expect(block).toContain(flatten(target.copy.noscript));
          expect(block, 'the no-JS alternative is in the wrong language').not.toContain(
            flatten(target.other.noscript),
          );
          // `:visible`, because the failure block's own mailto is in the DOM too — it
          // is part of the form that is no longer on display.
          const mail = seen.page.locator('[data-form-wrap] a[href^="mailto:"]:visible');
          expect(await mail.count(), 'no reachable mailto link').toBeGreaterThan(0);

          // Nothing it says is about the enhanced path: there is no in-page
          // confirmation to come, and no send button that could send anything.
          for (const promise of [target.copy.sentTitle, target.copy.sentBody, target.copy.submit]) {
            expect(block, 'the no-JS copy promises the enhanced path').not.toContain(
              flatten(promise),
            );
          }

          // Every link offered is the one route that works without JavaScript. Read as
          // attributes rather than through `evaluateAll`, which needs page scripting.
          const links = await seen.page.locator('[data-form-wrap] a:visible').all();
          expect(links.length).toBeGreaterThan(0);
          for (const link of links) {
            const href = (await link.getAttribute('href')) ?? '';
            expect(href.startsWith('mailto:'), `a link that is not the inbox: ${href}`).toBe(true);
          }

          /**
           * And the 405 itself. Every control that could still submit is clicked for
           * real — with JavaScript genuinely disabled, so nothing intercepts it — and
           * the browser must not have navigated anywhere, least of all to a 405.
           *
           * This is what gives the test teeth in the reverted state: put `method="post"`
           * back and the submit is visible, the click reaches the host, and the
           * navigation that lands is the 405 this defect is named after.
           */
          const clickable = seen.page.locator(
            '[data-form-wrap] [type="submit"]:visible, [data-form-wrap] [data-submit]:visible',
          );
          for (const control of await clickable.all()) {
            await control.click({ timeout: 4_000 }).catch(() => null);
            await seen.page.waitForTimeout(500);
          }
          expect(
            seen.navigations.filter((status) => status === 405),
            'submitting without JavaScript left the visitor on a 405',
          ).toEqual([]);
          expect(seen.page.url(), 'submitting without JavaScript navigated away').toBe(seen.url);
        } finally {
          await seen.close();
        }
      });
    }
  }
});
