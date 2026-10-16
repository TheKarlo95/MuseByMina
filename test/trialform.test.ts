import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks, openCheckPage } from '../scripts/browser-checks.mjs';
import { FORM_COPY, type FormCopy } from '../src/lib/forms';
import { DEFAULT_LOCALE, type Locale } from '../src/lib/i18n';
import { ROUTES } from '../src/lib/pages';
import { settleInteraction } from './helpers/browser-settle';
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
  /**
   * Read off the copy table, not written out (MUSE-18): the submitted value is the
   * level key now, and a literal here was one of the three places `pocetni` lived.
   */
  level: FORM_COPY.hr.levels[1]!.value,
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
    launchChecks(),
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

/**
 * Open `route` on `preview`, as a visitor of that route's language.
 *
 * Through `scripts/browser-checks.mjs` (MUSE-48), which derives the locale from the route
 * and asserts the landing URL. This suite used to pick the browser language itself, with
 * a comment saying that without it every assertion about `/` is one about `/en` — true,
 * and one of four hand-written copies of the same rule.
 *
 * The listeners are installed through `prepare`, which runs before the first navigation:
 * `navigations` has to see the *first* document's status, not just the ones after it.
 */
async function visit(
  preview: Preview,
  route: string,
  opts: { javaScript?: boolean } = {},
): Promise<Visit> {
  const logged: { type: string; text: string }[] = [];
  const navigations: number[] = [];

  const { page, context, measured, close } = await openCheckPage(browser, preview, route, {
    context: {
      colorScheme: 'dark',
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: opts.javaScript ?? true,
    },
    prepare: (opened) => {
      opened.on('console', (msg) => logged.push({ type: msg.type(), text: msg.text() }));
      opened.on('response', (response) => {
        if (response.request().isNavigationRequest()) navigations.push(response.status());
      });
    },
  });

  return {
    page,
    url: measured.url,
    console: logged,
    navigations,
    offline: (on) => context.setOffline(on),
    close,
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
 *
 * ---
 *
 * **What this answers, and what it cannot** (MUSE-53).
 *
 * It answers **provenance**: *did we write this, in this visitor's language?* Anything
 * that is not in `FORM_COPY` and not content survives the subtraction and fails,
 * whatever it says, which is the whole reason this is a subtraction rather than a search
 * for `PUBLIC_FORM_ENDPOINT` and `/^HTTP \d{3}/`.
 *
 * It does not answer **placement**: *should this string be on this page?* Every string
 * in `FORM_COPY` is by definition "something we wrote", so `phrases()` subtracts all of
 * them from every page this suite visits — including strings that belong on one page
 * only. `FORM_COPY` is shared by `/`, `/contact` and `/pricing`, so the subtraction set
 * here is *everything the form can ever say*, and it grows every time anybody adds a
 * line. Measured rather than reasoned about: ungating the package `<select>` so that it
 * leaks onto `/contact` leaves this file at **38 passed**.
 *
 * That gap is covered by `GATED_COPY` in `src/lib/forms.ts` and the placement suite in
 * `test/formcopy.test.ts`, which renders the component under each prop shape and fails
 * on a string that appears where its gate is off. Nothing below should be rewritten to
 * try to cover it: a residue assertion that knew which page it was on would need the
 * per-page copy list this repository has re-filed six times.
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
  /**
   * **The one combination nothing drove, and the reason MUSE-110 had to be checked
   * rather than assumed.**
   *
   * The two conditions are independent: `send()` throws for the missing endpoint
   * *inside* the `try`, so the `catch` still reads `navigator.onLine` and still picks
   * the offline line. So the offline copy is reachable on the deploy that has no
   * endpoint, and a gate on the generic body alone would have left half the defect
   * live. Driven here rather than reasoned about — the suite had a cell for each
   * condition and none for both.
   */
  {
    label: 'the visitor is offline and no endpoint is configured',
    build: 'none',
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

/**
 * How long the visitor's answer is allowed to take before this is called a failure.
 *
 * **The condition was never the problem; the budget was** (MUSE-54). `[data-form-status]`
 * becoming visible is exactly the right thing to wait for — it is `showStatus()` having
 * run, which is the whole of the behaviour under test — and there is no earlier signal
 * that would be more precise. So nothing here was converted into a different wait.
 *
 * What is wrong with 15 s is that it is a wall clock on a machine this suite does not own.
 * `npm test` runs ten real `astro build`s in parallel workers and several Chromium
 * instances beside them, and several agents doing that at once in separate worktrees is
 * normal here. Starve the renderer and two things slow down together: the click handler,
 * the `fetch` and `showStatus()` on one side, and **Playwright's own polling of the
 * selector on the other** — `waitForSelector` evaluates its predicate on the page's frame
 * clock, so the condition can be satisfied for a while before anything is in a position to
 * notice. That is how this timed out twice in eight runs on one branch while three
 * baseline runs on `main` were clean.
 *
 * 40 s, inside the 60 s `testTimeout`: the rest of this test is one page load and five
 * field fills, so the headroom is real. A budget that is wrong is better than one that is
 * tight, because the cost of tight is not the re-run — it is that the next genuine failure
 * gets re-run too.
 */
const STATUS_BUDGET = 40_000;

/**
 * Wait for the failure block, and if it never comes say what the page was actually doing.
 *
 * The other half of MUSE-54's complaint about this wait: the bare Playwright timeout named
 * a selector and nothing else, so the two sightings were indistinguishable from a real
 * regression without re-running them. Every observable that separates the candidates is
 * read here instead — whether the stub was even reached, whether the submission is still
 * in flight (`aria-busy`), whether the *success* block was shown by mistake, and what the
 * page logged.
 */
async function awaitFailureBlock(
  seen: Visit,
  preview: Preview,
  label: string,
  /** Submissions the stub had already taken before this one — it is shared across tests. */
  sent: number,
): Promise<void> {
  try {
    await seen.page.waitForSelector('[data-form-status]:not([hidden])', {
      timeout: STATUS_BUDGET,
    });
  } catch (cause) {
    const state = await seen.page
      .evaluate(() => {
        const form = document.querySelector<HTMLFormElement>('[data-trial-form]');
        const status = document.querySelector<HTMLElement>('[data-form-status]');
        const sent = document.querySelector<HTMLElement>('[data-sent]');
        const label_ = document.querySelector<HTMLElement>('[data-submit-label]');
        return {
          busy: form?.getAttribute('aria-busy') ?? '—',
          statusHidden: status === null ? 'no such element' : String(status.hidden),
          sentShown: sent === null ? 'no such element' : String(!sent.hidden),
          submit: label_?.textContent?.trim() ?? '—',
        };
      })
      .catch((problem: unknown) => ({
        busy: `unreadable (${String(problem)})`,
        statusHidden: '?',
        sentShown: '?',
        submit: '?',
      }));

    throw new Error(
      [
        `gave up waiting for the failure block after ${STATUS_BUDGET}ms (${label}).`,
        `  stub endpoint reached   ${preview.requests.length - sent} time(s) by this submit`,
        `  form aria-busy          ${state.busy}`,
        `  [data-form-status]      hidden=${state.statusHidden}`,
        `  [data-sent]             shown=${state.sentShown}`,
        `  submit button says      ${state.submit}`,
        `  page is on              ${seen.page.url()}`,
        `  console                 ${seen.console.map((line) => `${line.type}: ${line.text}`).join(' | ') || '(nothing)'}`,
        '',
        'aria-busy=true means the submission is still in flight and the budget above was',
        'too short for this machine. aria-busy=false with the status still hidden means',
        'the handler finished and rendered nothing, which is a regression.',
      ].join('\n'),
      { cause },
    );
  }
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
    const sent = preview.requests.length;
    await seen.page.click('[data-submit]');
    await awaitFailureBlock(seen, preview, `${target.locale}: ${failure.label}`, sent);
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
            /**
             * A quiet network, not half a second (MUSE-54).
             *
             * This is a negative claim — nothing may have navigated — and the only
             * observable that can support one is that no document request is still in
             * the air. `scripted: false` because JavaScript is genuinely disabled in this
             * context, so there is no frame loop to run in the page; the network is all
             * there is. Unlike a sleep, any activity restarts the quiet window, so this
             * gets more patient as the machine gets busier rather than less.
             */
            await settleInteraction(seen.page, 'a native submission to land or not', {
              scripted: false,
            });
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

/**
 * **MUSE-72 — the notice and the form's configuration are one fact, proved in both states.**
 *
 * The defect this is the guard for: `/privacy/` asserted in the present tense, in both
 * locales, that Formspark acted as the studio's processor, that a DPA was in place and that
 * Formspark emailed the messages through — with `PUBLIC_FORM_ENDPOINT` unset for the life of
 * the project and MUSE-12 recording that the form has never delivered a message. Three
 * false claims in a statutory document, and the whole suite green, because the claim was
 * prose in a component and the fact was an environment variable. **Nothing compared them.**
 *
 * This is that comparison, and it has to be a build to be worth anything: `FORM_HAS_PROCESSOR`
 * is read at build time, so a unit test importing the module would measure the vitest
 * process's environment rather than the page's.
 *
 * **It lives here rather than in a file of its own, and that is a deliberate trade.** The
 * assertion needs the site built *both* ways and this is the one suite that already has
 * both — `configured` and `unconfigured` in the `beforeAll` above, serving the two states
 * MUSE-15 needed for the same reason. A new file would have cost two more `astro build`s
 * against `test/helpers/concurrency.ts`'s zero headroom, which buys a tidier filename with
 * a measurable worsening of MUSE-68's flake. The subject is the same either way: this file
 * is where the form's endpoint configuration is driven, and the notice is now one of its
 * readers.
 *
 * Both directions are asserted, which is the half that was missing. A guard that only
 * checked the unset state would pass today and go quiet the moment MUSE-12 lands.
 */
describe('MUSE-72: the privacy notice describes the form that was actually built', () => {
  /**
   * Phrases that assert a *named* processor, an agreement with one, or a flat denial of
   * third-country transfer.
   *
   * A named provider is the ticket's first defect and must appear in neither state: a URL
   * in an environment variable says that *somebody* receives the data, never who, so no
   * build can honestly name one. The no-third-country denial must appear in neither state
   * either — Formspark's own sub-processor list puts Sentry and Mapbox in the US, so the
   * claim is the site asserting something the processor declines to assert.
   */
  const NEVER = [
    'Formspark',
    'formspark',
    'submit-form.com',
    // The flat denial, both locales.
    'nema prijenosa u treć',
    'no transfer to a third country',
    // The invented retention commitments.
    '12 mjeseci',
    '12 months',
    'evidencija polaznika',
    'evidenciju polaznika',
    'student records',
  ];

  /**
   * What the recipient paragraph says when a processor exists, and when none does.
   *
   * Read as *categories* rather than names — Art. 13(1)(e) takes either, and a category is
   * the only thing derivable from a configured URL. Deliberately short phrases: the
   * assertion is about which of the two paragraphs was rendered, not about the wording,
   * which belongs to whoever reviews the notice.
   */
  const RECIPIENT = {
    hr: { processor: 'vanjska usluga', none: 'nije povezan ni s jednom vanjskom uslugom' },
    en: {
      processor: 'an external service',
      none: 'not currently connected to any external service',
    },
  } as const;

  const NOTICES = [
    { locale: 'hr', route: '/privacy' },
    { locale: 'en', route: '/en/privacy' },
  ] as const;

  const STATES = [
    { label: 'an endpoint configured', processor: true, preview: () => configured },
    { label: 'no endpoint configured', processor: false, preview: () => unconfigured },
  ] as const;

  /** The notice as built, markup stripped so a phrase split by a tag still reads. */
  async function notice(preview: Preview, route: string): Promise<string> {
    const html = await (await fetch(preview.url(route))).text();
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1];
    expect(main, `${route} has no <main>`).toBeDefined();
    return main!
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  }

  for (const state of STATES) {
    for (const { locale, route } of NOTICES) {
      it(`${locale}, ${state.label}: the recipient paragraph matches the build`, async () => {
        const body = await notice(state.preview(), route);
        const expected = RECIPIENT[locale];

        if (state.processor) {
          expect(
            body,
            'an endpoint is configured, so submissions do reach a third party and the ' +
              'notice has to say so',
          ).toContain(expected.processor);
          expect(
            body,
            'the notice still claims nobody receives the data while an endpoint is configured',
          ).not.toContain(expected.none);
        } else {
          // The shipping state, and the one the defect was live in.
          expect(
            body,
            'no endpoint is configured, so nothing is transmitted to anybody and the ' +
              'notice must not describe a processor',
          ).toContain(expected.none);
          expect(
            body,
            'the notice describes a processor that this build has no endpoint for — the ' +
              'MUSE-72 defect, exactly',
          ).not.toContain(expected.processor);
        }
      });

      it(`${locale}, ${state.label}: names no provider and denies no transfer`, async () => {
        const body = await notice(state.preview(), route);
        for (const phrase of NEVER) {
          expect(
            body,
            `the notice says "${phrase}", which nothing here can support`,
          ).not.toContain(phrase);
        }
      });
    }
  }

  /**
   * The erasure right and the purpose, which replaced the invented twelve months.
   *
   * Asserted as *present* rather than only as "the number is gone": deleting a retention
   * claim and leaving the section empty would pass the `NEVER` list above and would be a
   * worse notice than the wrong one, since Art. 13(2)(a) wants the criteria when the period
   * itself cannot be given.
   */
  for (const { locale, route } of NOTICES) {
    it(`${locale}: retention is stated as a purpose limit plus the erasure right`, async () => {
      const body = await notice(unconfigured, route);
      const criterion =
        locale === 'hr' ? 'dok su za tu svrhu potrebni' : 'as long as that purpose needs';
      const erasure = locale === 'hr' ? 'Brisanje možeš zatražiti' : 'ask us to delete them';
      expect(body, 'no retention criterion at all').toContain(criterion);
      expect(body, 'the erasure right is not offered where retention is described').toContain(
        erasure,
      );
    });
  }

  /**
   * AZOP's current address, in both locales and both states.
   *
   * No test can check this against the Agency — the suite never touches the network, and
   * there is no second surface on the site to compare it with. What a test *can* pin is
   * that the superseded address has not come back, and that the notice still names an
   * authority at all: an address silently dropped is a reader with no route to a regulator.
   * The dated provenance comment in `Privacy.astro` is the rest of the guard.
   */
  for (const { locale, route } of NOTICES) {
    it(`${locale}: the supervisory authority has its post-May-2025 address`, async () => {
      const body = await notice(unconfigured, route);
      expect(body).toContain('AZOP');
      expect(body, 'AZOP is named with no address to write to').toContain(
        'Ulica Metela Ožegovića 16',
      );
      expect(body, 'the address AZOP moved out of in May 2025').not.toContain('Selska cesta');
    });
  }
});

/**
 * **MUSE-84 — `/contact` instructs the visitor to use the path this build actually has.**
 *
 * The defect: the hero told the visitor to submit the form — „Ispuni obrazac i javljamo se
 * s terminom koji ti odgovara." / "Fill in the form and we will come back with a time that
 * suits you." — on a deploy where `PUBLIC_FORM_ENDPOINT` is unset, so `TrialForm.astro`
 * throws before any `fetch` and every submission ends in „Prijava nije poslana." with the
 * inbox offered instead. The instruction was false at the moment it was followed, and it
 * was repeated in `page-contact.description`, so in both `<meta name="description">` tags
 * and two `llms.txt` lines.
 *
 * It is MUSE-72's defect one surface over: a present-tense description of a mechanism that
 * is absent, with the claim in prose and the fact in configuration and nothing comparing
 * them. MUSE-72 fixed the notice and stopped at the page it was filed against; the privacy
 * notice has said „Zato ti obrazac, kad ga pokušaš poslati, umjesto potvrde ponudi našu
 * e-mail adresu." since, so `/privacy` and `/contact` contradicted each other about the
 * same form on the same deploy.
 *
 * So the hero reads `FORM_HAS_PROCESSOR`, exactly as the notice does, and this is the
 * comparison — in the same file and against the same two builds, which is why it costs no
 * build against `test/helpers/concurrency.ts`'s zero headroom.
 *
 * **The `page` description is the half that cannot be gated, and that is the one worth
 * reading.** It is a `page` document: Sanity owns a page's words (MUSE-20), so there is no
 * branch to put it in and no configuration it can read. A CMS string beside a conditional
 * mechanism therefore has exactly one honest shape — **it must be true in both states** —
 * which means it may not name the form at all. The assertion below is run against both
 * builds for that reason: the same claim twice is not a weaker test here, it is the whole
 * statement. Gating it would mean a second description source in code, which is the one
 * thing `getPage(route)` exists to prevent.
 */
/**
 * **The two primitives both class needles in this file are built out of (MUSE-84, MUSE-110).**
 *
 * Module scope rather than inside one `describe`, because the *boundary* they draw is
 * one rule and not two: a claim and a statement that the thing cannot be done are the
 * same verb and the same object with „ne" / "not" between them, so a needle for either
 * claim has to refuse a negation in the gap and in front of the verb. Two copies of
 * that rule would be two chances to widen only one of them.
 *
 * `step` is one word of slack that is not a negation.
 */
const NEGATION_HR = String.raw`ne|ni|nije|nemoj|nemojte|nećemo`;
const NEGATION_EN = String.raw`not|cannot|never|without`;
const step = (negations: string) =>
  String.raw`(?:[^\p{L}\d]+(?!(?:${negations})(?![\p{L}\d]))[\p{L}\d’']+)`;
const HR_STEP = step(NEGATION_HR);
const EN_STEP = step(NEGATION_EN);

/**
 * **The surfaces both class needles are asked of, read off the build in one place
 * (MUSE-109).**
 *
 * MUSE-84's needle was applied to three strings — one section of `/contact`, that page's
 * `<meta name="description">` and `llms.txt` — while MUSE-110's was applied to every
 * `data-msg-*` attribute on every page that renders the form. Each had its own copy of
 * the plumbing, so the second guard's wider reach was unavailable to the first: a
 * `data-msg-*` reading „pošalji obrazac" instructs a submission with no adverb anywhere
 * in it, which is outside `RETRY` by construction and was outside `SUBMIT` by scope.
 *
 * One list and one parser, hoisted here rather than copied, because "which pages render
 * the form" is a derived fact, and two derivations of one fact are two things to keep
 * agreeing — which is the argument `test/routes.test.ts` is built on.
 */
interface Message {
  /** The attribute's suffix: `fail-body` for `data-msg-fail-body`. */
  name: string;
  value: string;
}

/** Entities decoded, so an attribute's text reads as the visitor will see it. */
const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

async function pageMarkup(preview: Preview, route: string): Promise<string> {
  const response = await fetch(preview.url(route));
  expect(response.status, `${route} did not build`).toBe(200);
  return await response.text();
}

/** `/schedule` → `/en/schedule`; `/` → `/en`. The spelling `preview.url` takes. */
const localeRoute = (route: string, locale: Locale): string =>
  locale === DEFAULT_LOCALE ? route : route === '/' ? '/en' : `/${locale}${route}`;

/**
 * **Every message the browser can show, read off the page.**
 *
 * The copy reaches the script as `data-msg-*` and is invisible until something writes it
 * into the alert, so the markup is the only place the whole set is observable at once —
 * and reading the attributes rather than a list of names means a message added next year
 * is inside both guards without anybody adding it.
 */
const messagesIn = (html: string): Message[] =>
  [...html.matchAll(/data-msg-([a-z-]+)="([^"]*)"/g)].map((match) => ({
    name: match[1]!,
    value: decodeEntities(match[2]!),
  }));

/**
 * **Which pages render the form — derived, with a floor.**
 *
 * Walked off `ROUTES` rather than listed, so the guards cover `/`, `/contact` and
 * `/pricing` today because they carry the form and not because this file names them, and
 * a fourth embedding joins on its own. The floor is what stops a renamed
 * `data-trial-form` turning every loop over this list into a loop over nothing.
 */
const formPages: { locale: Locale; route: string }[] = [];

beforeAll(async () => {
  for (const locale of ['hr', 'en'] as const) {
    for (const { route } of ROUTES) {
      const spelling = localeRoute(route, locale);
      if ((await pageMarkup(unconfigured, spelling)).includes('data-trial-form')) {
        formPages.push({ locale, route: spelling });
      }
    }
  }
}, 60_000);

describe('the pages the class needles are asked of', () => {
  it('finds the pages that render the form', () => {
    expect(
      formPages.length,
      'no page under ROUTES renders [data-trial-form] — has the form or the attribute ' +
        'been renamed? Every assertion that loops over the form pages reads this list',
    ).toBeGreaterThanOrEqual(6);
  });
});

describe('MUSE-84: the contact copy describes the form that was actually built', () => {
  /**
   * Which of the two heroes was rendered.
   *
   * Short phrases on purpose, as MUSE-72's `RECIPIENT` is: the assertion is about which
   * branch the build took, not about the wording, which belongs to whoever reviews the
   * page. The negative direction needs the *imperative* rather than the word „obrazac" —
   * the honest branch names the form too, in order to say it cannot be received.
   */
  const HERO = {
    hr: { form: 'Ispuni obrazac', inbox: 'Obrazac trenutačno ne možemo primiti' },
    en: { form: 'Fill in the form', inbox: 'We cannot receive the form at the moment' },
  } as const;

  /**
   * **The other half, and the half MUSE-72 would be missing without it.**
   *
   * `HERO` above is `RECIPIENT`'s shape: *which branch rendered*, in short phrases, both
   * directions. That is necessary and it is not sufficient, because every needle in it is
   * **the sentence this ticket happened to delete**. A guard built only out of those
   * phrases says "the old wording is gone and the new wording is here", so the defect
   * comes back the moment somebody says the same thing differently — reviewed and
   * measured on this branch: a description reading „… pošalji obrazac na ovoj stranici." /
   * "… submit the form on this page." left 207 tests green and published into both
   * `<meta name="description">` tags and both `llms.txt` lines, and a gated second
   * sentence beside the honest one („Prijavu možeš poslati i kroz obrazac ispod.") left
   * 202 green while the hero contradicted itself on the page.
   *
   * `NEVER` is MUSE-72's answer to that, and it is why that guard would catch a notice
   * naming a *different* non-existent processor: a **class** of claim, asserted
   * independently of which branch rendered. This is that class — "the copy tells the
   * visitor to submit the form" — as a verb-and-object adjacency rather than a phrase, so
   * the wording is free to change and the claim is not.
   *
   * **It cannot live in `test/helpers/offer-claims.ts`**, which is where MUSE-71's and
   * MUSE-80's class needles are, for two reasons that are about this claim rather than
   * about that file. It is **conditional**: with an endpoint configured the instruction is
   * legitimate and *must* be present, and `RETIRED_CLAIMS` is a list of things that may
   * never appear anywhere. And the honest branch itself names the form in order to say it
   * cannot be received, as does `/privacy`'s „Zato ti obrazac, kad ga pokušaš poslati,
   * umjesto potvrde ponudi našu e-mail adresu." — so the needles have a boundary to
   * respect, and `INNOCENT_FORM_PROSE` tests it from both sides the way `INNOCENT` does.
   *
   * Two directions per locale, because Croatian puts the object first as readily as the
   * verb („Obrazac ispuni i javljamo se."). The object-first window is **tighter** — two
   * words — and the gap is bounded in both: „obrazac, kad ga pokušaš poslati" puts a
   * listed verb three words out and is pinned below.
   *
   * **Negation is the boundary, and it is a distinction rather than an exemption.** An
   * instruction and a statement that the thing cannot be done are the same verb and the
   * same object with „ne" between them: „Bez JavaScripta ovaj se obrazac **ne može**
   * poslati" (`FormCopy['noscript']`) is true in every state and is the opposite of a
   * claim. So a negation may be neither the word in the gap nor the word in front of the
   * verb, which is what the lookaheads and the lookbehind are for. Without that, the
   * needle read the `<noscript>` line as an instruction — measured, which is why it is
   * written this way and why that sentence is in `INNOCENT_FORM_PROSE`.
   */
  /**
   * **„obrazac" loses its `z` in every oblique case, and the needle covered one case form
   * out of seven** (MUSE-109). The object was `obraz[\p{L}]*`, which cannot match
   * „obrasca", „obrascu", „obrascem", „obrasci" or „obrasče" — and the oblique cases are
   * how the instruction is naturally phrased: „preko obrasca", „putem obrasca", „u
   * obrascu". Every tooth below used to be nominative or accusative, so the needle set was
   * only ever exercised against the one form it happened to cover, while `src/lib/forms.ts`
   * already writes „u obrascu" twice. `obra[sz]` closes it, and `OBRAZAC_HR` pins the whole
   * declension against the pattern so a future narrowing is a red test rather than a
   * sentence nobody wrote down.
   *
   * The plural genitive is „obrazaca" and keeps the `z`, so the character class is a class
   * rather than a second stem.
   */
  const OBJECT_HR = String.raw`obra[sz][\p{L}]*`;

  /**
   * **Every form of the word, so the teeth cannot all be one inflection.** All seven
   * singular cases and the four plural surfaces; the two cases that share a surface
   * („obrascu" is both dative and locative) are separate entries, because a tooth is
   * labelled with the case it means and the label is what the coverage check reads.
   *
   * Every entry is asserted against the object pattern. Only `SENTENCE_FORMS` — the forms
   * studio copy can actually reach for — is required to appear in a sentence: a vocative
   * of an inanimate noun would be an invented sentence, and an invented sentence in a
   * tooth is a tooth about nothing.
   */
  const OBRAZAC_HR = {
    nominative: 'obrazac',
    genitive: 'obrasca',
    dative: 'obrascu',
    accusative: 'obrazac',
    vocative: 'obrasče',
    locative: 'obrascu',
    instrumental: 'obrascem',
    plural: 'obrasci',
    pluralGenitive: 'obrazaca',
    pluralAccusative: 'obrasce',
    pluralDative: 'obrascima',
  } as const;

  /** The case forms a tooth has to exercise, which is MUSE-109's first criterion. */
  const SENTENCE_FORMS = [
    'nominative',
    'genitive',
    'dative',
    'accusative',
    'locative',
    'instrumental',
  ] as const satisfies readonly (keyof typeof OBRAZAC_HR)[];

  /**
   * **The English window is four words and a determiner spends one** (MUSE-109).
   * "Send us a request in form." was caught and "Send us your request using the form
   * below." escaped: the trailing `[^\p{L}\d]+` cannot absorb "the", so the determiner
   * ate a slot that the gap needed for a content word. The Croatian verb-first needle
   * avoided this by accident — „prijav" is in the verb list and „prijavu" is a *noun*, so
   * a later noun re-anchored the match and widened the window.
   *
   * The slot is optional and sits against the object rather than widening the gap, so the
   * window stays four *content* words in both locales and the bound the object-first
   * needle depends on is untouched.
   */
  const DETERMINER_EN = String.raw`(?:the|a|an|this|that|these|those|our|your|their|its|my)`;
  const OBJECT_EN = String.raw`(?:${DETERMINER_EN}[^\p{L}\d]+)?\bforms?\b`;

  /**
   * **The verbs, as a list rather than inside the pattern** (MUSE-109), because the other
   * half of a class needle is which verbs it knows and a list can be asserted against the
   * teeth: the lists and `INSTRUCTIONS_HR`/`INSTRUCTIONS_EN` are compared below, so a verb added
   * with no sentence behind it is a red test and the next gap is at least visible.
   *
   * `ostavi`, `javi`, `piši` and `koristi` / `leave`, `sign`, `tell` and `give` were the
   * measured gaps — „Svoje podatke ostavi u obrascu i zovemo te." missed on the verb and
   * on the case at once. The new Croatian stems carry their `i` on purpose: `javi[\p{L}]*`
   * matches „javi" and „javite" and **not** „javljamo" (we reply, which is not an
   * instruction and is all over the honest copy); `ostavi` likewise misses „ostali", which
   * is `failBody`'s „ostali u obrascu"; `piši` misses „piše" („the form says"), which is a
   * statement about the form rather than an instruction to send it.
   */
  const VERBS_HR = [
    'ispun',
    'popun',
    'pošalj',
    'poslat',
    'predaj',
    'predat',
    'prijav',
    'ostavi',
    'javi',
    'piši',
    'koristi',
  ] as const;
  const VERBS_EN = [
    'fill',
    'send',
    'submit',
    'complete',
    'use',
    'return',
    'post',
    'leave',
    'sign',
    'tell',
    'give',
  ] as const;

  const VERB_HR = String.raw`(?<!(?:${NEGATION_HR})[\s-])(?:${VERBS_HR.join('|')})[\p{L}]*`;
  const VERB_EN = String.raw`(?<!(?:${NEGATION_EN})[\s-])\b(?:${VERBS_EN.join('|')})\b`;

  const SUBMIT = {
    hr: {
      verbFirst: new RegExp(
        String.raw`${VERB_HR}${HR_STEP}{0,4}?[^\p{L}\d]+${OBJECT_HR}`,
        'iu',
      ),
      objectFirst: new RegExp(
        String.raw`${OBJECT_HR}${HR_STEP}{0,2}?[^\p{L}\d]+${VERB_HR}`,
        'iu',
      ),
    },
    en: {
      verbFirst: new RegExp(
        String.raw`${VERB_EN}${EN_STEP}{0,4}?[^\p{L}\d]+${OBJECT_EN}`,
        'iu',
      ),
      objectFirst: new RegExp(
        String.raw`\bforms?\b${EN_STEP}{0,2}?[^\p{L}\d]+${VERB_EN}`,
        'iu',
      ),
    },
  } as const;

  /** Every needle that fires on `text`, named, so a failure says which shape it was. */
  function instructsSubmission(text: string, locale: 'hr' | 'en'): string[] {
    return Object.entries(SUBMIT[locale])
      .filter(([, pattern]) => pattern.test(text))
      .map(([shape, pattern]) => `${shape}: ${JSON.stringify(pattern.exec(text)?.[0])}`);
  }

  /**
   * **What the needles have to catch.** The first of each pair is what the site published;
   * the rest are the rewordings a phrase-level guard let through — the two that were
   * measured green on this branch, plus the inverted word order Croatian makes free.
   *
   * This is the teeth. Without it the needles are a regex nobody has run against the
   * sentence they are for, which is the shape of defence this repository keeps re-filing.
   */
  interface ToothHR {
    /** The case form of „obrazac" the sentence uses — a key of `OBRAZAC_HR`. */
    form: keyof typeof OBRAZAC_HR;
    order: 'verbFirst' | 'objectFirst';
    /** The verb alternative this sentence is here to exercise. */
    verb: (typeof VERBS_HR)[number];
    text: string;
  }

  interface ToothEN {
    order: 'verbFirst' | 'objectFirst';
    /** The determiner standing between the verb and "form", if any. */
    determiner: string | null;
    verb: (typeof VERBS_EN)[number];
    text: string;
  }

  /**
   * **The teeth, labelled** (MUSE-109), because the labels are what makes the coverage a
   * property rather than a hope. The old list was six sentences per locale, every Croatian
   * one in the nominative or the accusative — so the needle set was green against a single
   * inflection and nothing said so. The tests below read `form`, `order` and `verb` and
   * require every case form, both word orders, each order with at least one oblique case,
   * and every verb in the list to be exercised by some sentence.
   *
   * The first of each pair is what the site published; the rest are the rewordings a
   * phrase-level guard let through — the two measured green on MUSE-84's branch, the
   * inverted word order Croatian makes free, and the declined forms and verbs MUSE-109
   * measured escaping.
   */
  const INSTRUCTIONS_HR: ToothHR[] = [
    {
      form: 'accusative',
      order: 'verbFirst',
      verb: 'ispun',
      text: 'Ispuni obrazac i javljamo se s terminom koji ti odgovara.',
    },
    {
      form: 'accusative',
      order: 'verbFirst',
      verb: 'pošalj',
      text: 'Prijavi se na probni sat bachate u Zagrebu. Javi nam se i dogovaramo termin — pošalji obrazac na ovoj stranici.',
    },
    {
      form: 'accusative',
      order: 'objectFirst',
      verb: 'ispun',
      text: 'Obrazac ispuni i javljamo se s terminom.',
    },
    {
      form: 'accusative',
      order: 'verbFirst',
      verb: 'popun',
      text: 'Popunite obrazac i čekajte poziv.',
    },
    {
      form: 'accusative',
      order: 'verbFirst',
      verb: 'prijav',
      text: 'Prijavi se kroz obrazac.',
    },
    {
      form: 'accusative',
      order: 'verbFirst',
      verb: 'koristi',
      text: 'Koristi obrazac ispod.',
    },
    {
      form: 'nominative',
      order: 'objectFirst',
      verb: 'poslat',
      text: 'Obrazac se može poslati i kasnije.',
    },
    // The ticket's own failure scenario: a `page` description that the whole MUSE-84
    // guard, replayed, passed.
    {
      form: 'genitive',
      order: 'verbFirst',
      verb: 'prijav',
      text: 'Prijavi se na probni sat bachate u Zagrebu. Javi nam se ili se prijavi preko obrasca na ovoj stranici.',
    },
    {
      form: 'genitive',
      order: 'verbFirst',
      verb: 'pošalj',
      text: 'Prijavu nam pošalji putem obrasca.',
    },
    {
      form: 'genitive',
      order: 'objectFirst',
      verb: 'pošalj',
      text: 'Preko obrasca pošalji prijavu.',
    },
    {
      form: 'dative',
      order: 'verbFirst',
      verb: 'predaj',
      text: 'Prijavu predaj obrascu ispod.',
    },
    {
      form: 'dative',
      order: 'objectFirst',
      verb: 'pošalj',
      text: 'Vjeruj obrascu i pošalji prijavu.',
    },
    {
      form: 'locative',
      order: 'verbFirst',
      verb: 'prijav',
      text: 'Prijavi se u obrascu na ovoj stranici.',
    },
    {
      form: 'locative',
      order: 'verbFirst',
      verb: 'predat',
      text: 'Prijavu možeš predati u obrascu ispod.',
    },
    {
      form: 'locative',
      order: 'verbFirst',
      verb: 'ostavi',
      text: 'Svoje podatke ostavi u obrascu i zovemo te.',
    },
    {
      form: 'locative',
      order: 'verbFirst',
      verb: 'piši',
      text: 'Piši nam u obrascu ispod.',
    },
    {
      form: 'locative',
      order: 'objectFirst',
      verb: 'ostavi',
      text: 'U obrascu ispod ostavi svoje podatke.',
    },
    {
      form: 'instrumental',
      order: 'verbFirst',
      verb: 'pošalj',
      text: 'Prijavu pošalji obrascem na ovoj stranici.',
    },
    {
      form: 'instrumental',
      order: 'objectFirst',
      verb: 'pošalj',
      text: 'Obrascem ispod pošalji prijavu.',
    },
    {
      form: 'plural',
      order: 'objectFirst',
      verb: 'ispun',
      text: 'Obrasci ispod čekaju — ispuni oba.',
    },
    {
      form: 'pluralGenitive',
      order: 'verbFirst',
      verb: 'javi',
      text: 'Javi nam se putem obrazaca ispod.',
    },
    {
      form: 'pluralAccusative',
      order: 'verbFirst',
      verb: 'pošalj',
      text: 'Pošalji obrasce na ovoj stranici.',
    },
    {
      form: 'pluralDative',
      order: 'objectFirst',
      verb: 'ostavi',
      text: 'U obrascima ispod ostavi podatke.',
    },
  ];

  const INSTRUCTIONS_EN: ToothEN[] = [
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'fill',
      text: 'Fill in the form and we will come back with a time that suits you.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'submit',
      text: 'Sign up for a bachata trial class in Zagreb. Get in touch and we will find a time — submit the form on this page.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'send',
      text: 'You can also send your request through the form below.',
    },
    {
      order: 'objectFirst',
      determiner: null,
      verb: 'fill',
      text: 'The form? Fill it in below and we will be in touch.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'complete',
      text: 'Complete the form and we will come back with a time.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'use',
      text: 'Use the form below.',
    },
    // MUSE-109's measured escape: four content words and a determiner is five slots.
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'send',
      text: 'Send us your request using the form below.',
    },
    {
      order: 'verbFirst',
      determiner: null,
      verb: 'send',
      text: 'Send us a request in form.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'leave',
      text: 'Leave your details in the form below.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'sign',
      text: 'Sign up through the form on this page.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'tell',
      text: 'Tell us in the form below and we will reply.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'give',
      text: 'Give us your details using the form below.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'return',
      text: 'Return the form to us.',
    },
    {
      order: 'verbFirst',
      determiner: 'the',
      verb: 'post',
      text: 'Post the form through this page.',
    },
  ];

  /**
   * **Prose that legitimately names the form, and must not match.** Each is asserted
   * *live* as well as non-matching, `INNOCENT`'s pattern: a boundary tested only against
   * strings written in a test file drifts away from the page it is protecting.
   *
   * The first two are the honest hero this ticket shipped — in scope, and it names the
   * form. Then `FormCopy['noscript']`, which is the sentence that *measured* the need for
   * the negation rule, read off the copy table rather than quoted. Then `/privacy`'s, which
   * MUSE-72 wrote and which says the same true thing one page over. Then
   * `page-privacy.description`, which is in `llms.txt` beside `/contact`'s and so inside
   * the scan.
   *
   * **`build` is which deploy state publishes the string, and MUSE-109 is why it exists.**
   * Two of the entries below are the *configured* build's failure copy — „Tvoji odgovori
   * su ostali u obrascu…", which MUSE-110 gated, so with no endpoint it is not on the page
   * at all. Asserting it live against the shipping build would be asserting a string that
   * is correctly absent, and dropping the live half would be pinning six words nobody can
   * check. The three entries MUSE-109 added are the phrasings the widened object pattern
   * brings into reach: the two „u obrascu" lines in `src/lib/forms.ts` and `/privacy`'s
   * „upišeš u obrazac", which is the sentence that decides `upiš` may not join the verb
   * list.
   */
  const INNOCENT_FORM_PROSE = [
    {
      locale: 'hr',
      route: '/contact',
      build: 'unconfigured',
      text: 'Obrazac trenutačno ne možemo primiti',
    },
    {
      locale: 'en',
      route: '/en/contact',
      build: 'unconfigured',
      text: 'We cannot receive the form at the moment',
    },
    { locale: 'hr', route: '/contact', build: 'unconfigured', text: FORM_COPY.hr.noscript },
    { locale: 'en', route: '/en/contact', build: 'unconfigured', text: FORM_COPY.en.noscript },
    {
      locale: 'hr',
      route: '/privacy',
      build: 'unconfigured',
      text: 'Zato ti obrazac, kad ga pokušaš poslati, umjesto potvrde ponudi našu e-mail adresu',
    },
    {
      locale: 'en',
      route: '/en/privacy',
      build: 'unconfigured',
      text: 'That is why the form, when you try to send it, offers you our email address',
    },
    {
      locale: 'hr',
      route: '/privacy',
      build: 'unconfigured',
      text: 'Što obrazac za probni sat prikuplja, zašto, kome se prenosi',
    },
    {
      locale: 'en',
      route: '/en/privacy',
      build: 'unconfigured',
      text: 'What the trial-class form collects, why, who it is passed to',
    },
    // MUSE-109. „upišeš u obrazac" is what the visitor does to the form, not what the
    // page tells them to do with it; it is also the reason `upiš` is not a verb above.
    {
      locale: 'hr',
      route: '/privacy',
      build: 'unconfigured',
      text: 'upišeš u obrazac za probni sat',
    },
    {
      locale: 'en',
      route: '/en/privacy',
      build: 'unconfigured',
      text: 'what you type into the trial-class form',
    },
    // MUSE-109. The configured build's failure copy: „your answers are still in the form"
    // is a statement about where the input went, and „obrascu" is now inside the pattern.
    { locale: 'hr', route: '/contact', build: 'configured', text: FORM_COPY.hr.failBody },
    { locale: 'en', route: '/en/contact', build: 'configured', text: FORM_COPY.en.failBody },
    { locale: 'hr', route: '/contact', build: 'configured', text: FORM_COPY.hr.failOffline },
    { locale: 'en', route: '/en/contact', build: 'configured', text: FORM_COPY.en.failOffline },
  ] as const satisfies readonly {
    locale: 'hr' | 'en';
    route: string;
    build: 'configured' | 'unconfigured';
    text: string;
  }[];

  /**
   * The `page` description, which is one string for both states.
   *
   * Only the positive half is a phrase, and it is here for `RECIPIENT`'s reason: a
   * description with the instruction simply deleted would pass every needle above and
   * leave the `<meta name="description">` Google shows saying nothing about how to reach
   * the studio at all. The negative half is `SUBMIT`, so there is one answer to "does this
   * instruct a submission" rather than a phrase and a class disagreeing.
   */
  const DESCRIPTION = {
    hr: { reach: 'Javi nam se' },
    en: { reach: 'Get in touch' },
  } as const;

  const CONTACT = [
    { locale: 'hr', route: '/contact' },
    { locale: 'en', route: '/en/contact' },
  ] as const;

  const BUILDS = [
    { label: 'an endpoint configured', processor: true, preview: () => configured },
    { label: 'no endpoint configured', processor: false, preview: () => unconfigured },
  ] as const;

  /** Markup stripped, entities decoded, so a phrase split by a tag still reads. */
  function flat(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The hero section's own text — not the whole page, which offers the inbox anyway. */
  function hero(html: string): string {
    const section = /<section[^>]*class="hero[^"]*"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
    expect(section, 'no hero section').toBeDefined();
    return flat(section!);
  }

  function description(html: string): string {
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? html;
    const tag = /<meta[^>]*\bname="description"[^>]*>/.exec(head)?.[0];
    expect(tag, 'no <meta name="description">').toBeDefined();
    const content = /\bcontent="([^"]*)"/.exec(tag!)?.[1];
    expect(content, 'the description tag carries no content').toBeDefined();
    return flat(content!);
  }

  /**
   * The other string the `page` document publishes, and ungatable for the same reason
   * (MUSE-109): `<title>` is what a search result and a browser tab show, it comes out of
   * Sanity beside the description, and a title reading „Ispuni obrazac — Muse by Mina"
   * would have been outside every guard in this file.
   */
  function title(html: string): string {
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? html;
    const tag = /<title[^>]*>([\s\S]*?)<\/title>/.exec(head)?.[1];
    expect(tag, 'no <title>').toBeDefined();
    return flat(tag!);
  }

  /** The address the page itself offers — read off the page, never written out here. */
  function inbox(html: string): string {
    const address = /mailto:([^"'?]+)/.exec(html)?.[1];
    expect(address, 'the page offers no mailto: anywhere').toBeDefined();
    return address!;
  }

  for (const build of BUILDS) {
    for (const { locale, route } of CONTACT) {
      it(`${locale}, ${build.label}: the hero offers the path that works`, async () => {
        const html = await pageMarkup(build.preview(), route);
        const lede = hero(html);
        const expected = HERO[locale];

        if (build.processor) {
          expect(
            lede,
            'an endpoint is configured, so a submission does reach somebody and the ' +
              'instruction is true again',
          ).toContain(expected.form);
          expect(
            lede,
            'the hero still says the form cannot be received while an endpoint is configured',
          ).not.toContain(expected.inbox);
          expect(
            lede,
            'the hero offers the inbox as the way in while the form can actually send',
          ).not.toContain(inbox(html));
        } else {
          // The shipping state, and the one the defect was live in.
          expect(
            lede,
            'no endpoint is configured, so the form cannot send and the hero must not ' +
              'tell the visitor to submit it — the MUSE-84 defect, exactly',
          ).not.toContain(expected.form);
          expect(lede, 'the hero says nothing about the form it cannot send').toContain(
            expected.inbox,
          );
          expect(
            lede,
            'the hero says what does not work without offering what does: the inbox, ' +
              'which is what the form itself falls back to',
          ).toContain(inbox(html));
        }
      });

      /**
       * The class needle on the hero, in the state where the instruction cannot be true.
       *
       * Separate from the branch-identity test above and *not* folded into it, because
       * this one is the half that survives a rewording: the assertion is "nothing in this
       * hero tells the visitor to submit the form", whichever words are used and however
       * many sentences the branch grew.
       */
      if (!build.processor) {
        it(`${locale}: nothing in the hero instructs a submission this build cannot make`, async () => {
          const lede = hero(await pageMarkup(build.preview(), route));
          expect(
            instructsSubmission(lede, locale),
            'the hero tells the visitor to submit a form that cannot send. With no ' +
              'endpoint the only honest instruction is the inbox (MUSE-84); an ' +
              'instruction added beside the honest sentence is the same defect, and a ' +
              'reworded one is the same defect again',
          ).toEqual([]);
        });
      }

      it(`${locale}, ${build.label}: the page description instructs no submission`, async () => {
        const meta = description(await pageMarkup(build.preview(), route));

        expect(
          instructsSubmission(meta, locale),
          'the `<meta name="description">` Google shows instructs a form submission. It ' +
            'is a `page` document, so it cannot be gated on the endpoint and has to be ' +
            'true in both states — which means naming no mechanism at all',
        ).toEqual([]);
        expect(meta, 'the description offers no way to reach the studio at all').toContain(
          DESCRIPTION[locale].reach,
        );
      });

      it(`${locale}, ${build.label}: the page title instructs no submission`, async () => {
        const head = title(await pageMarkup(build.preview(), route));
        expect(
          instructsSubmission(head, locale),
          'the `<title>` instructs a form submission. It is the second string the `page` ' +
            'document publishes, so it has the description’s problem exactly — no branch ' +
            'to sit in, and it has to be true in both states (MUSE-109)',
        ).toEqual([]);
      });
    }

    it(`${build.label}: llms.txt says what the pages say`, async () => {
      const response = await fetch(`${build.preview().origin}/llms.txt`);
      expect(response.status, 'llms.txt did not build').toBe(200);
      const published = await response.text();

      for (const { locale } of CONTACT) {
        expect(
          instructsSubmission(published, locale),
          `llms.txt instructs a form submission in ${locale} — it publishes the same ` +
            'strings as the `<meta name="description">` tags, so it is the same claim ' +
            'again in the file written for machines',
        ).toEqual([]);
        expect(published, `llms.txt dropped the ${locale} contact description`).toContain(
          DESCRIPTION[locale].reach,
        );
      }
    });
  }

  /**
   * **The scope: a named set of rendered surfaces, and here is what is not in it**
   * (MUSE-109, fifth criterion).
   *
   * MUSE-84's needle read three strings — one section of `/contact`, that page's
   * `<meta name="description">` and `llms.txt` — while its own first criterion was that
   * *no page* instructs the visitor. The set is now:
   *
   * 1. `/contact`'s hero, both locales, in the state where the instruction cannot be true;
   * 2. `/contact`'s `<meta name="description">` **and** its `<title>`, both builds —
   *    the two strings the `page` document publishes and the two that cannot be gated;
   * 3. `llms.txt`, both builds, which republishes the description for machines;
   * 4. every `data-msg-*` attribute on every page that renders the form, derived from
   *    `ROUTES` — the surface below, and MUSE-110's reach brought to this needle.
   *
   * **It is not every page, and it is not the whole of any page, and the reason is a
   * measurement rather than a preference.** Asked of whole documents the needle fires on
   * `/contact`'s second section — „Ako ti je obrazac prekomplicirano, piši nam…", caught
   * in Croatian by `piši` and *not* in English, where "write to us" is not a submit verb.
   * That sentence is MUSE-110's deliberate exclusion: it is a claim about the shape of the
   * page rather than about the mechanism, it was given its own ticket, and
   * `docs/decisions/pages.md` refuses a pinned literal for it by name. So a page-wide
   * scope today would be either a red build on a sentence this ticket may not rewrite or
   * exactly the phrase-level exemption that file keeps arguing against.
   *
   * **And it is a needle about rendered surfaces, not about source.** `test/
   * offerclaims.test.ts` can scan `src/` because „free trial" appears nowhere in code;
   * this needle's object is also an HTML element, a variable and a Studio field
   * description — measured over `src/`, `sanity/` and the seed, thirteen lines fire and
   * eleven of them are `form.addEventListener('submit'`, `PUBLIC_FORM_ENDPOINT`'s comment
   * and „Ostavi prazno i prikazuje se obrazac za kontakt" in `offering.ts`. A source scan
   * here would be eleven exemptions and one real finding.
   *
   * **Unwatched, so the next author knows:** `/contact`'s second section (above); `/` and
   * `/pricing`'s prose around the form, which carries no caveat at all and is accepted
   * until MUSE-12; `/privacy`'s notice beyond the four strings pinned in
   * `INNOCENT_FORM_PROSE`; and every other page's prose, none of which names the form
   * today. A page that starts instructing a submission tomorrow is caught only if it does
   * it in `/contact`'s hero, in a `page` document or in a form message.
   */
  it('no form message on any page instructs a submission this build cannot make', async () => {
    for (const { locale, route } of formPages) {
      const messages = messagesIn(await pageMarkup(unconfigured, route));
      expect(
        messages.length,
        `${route} renders no data-msg-* attributes — this guard is reading the wrong markup`,
      ).toBeGreaterThan(0);

      const instructing = messages
        .filter((message) => instructsSubmission(message.value, locale).length > 0)
        .map((message) => `data-msg-${message.name}: ${JSON.stringify(message.value)}`);

      expect(
        instructing,
        `${route} tells the visitor to submit the form in a message the script can show, ` +
          'on a build with no endpoint where no submission is transmitted. MUSE-110 put ' +
          'every message inside a retry needle; a message reading „pošalji obrazac" ' +
          'instructs a submission with no adverb in it, so it is outside that needle and ' +
          'was outside this one too (MUSE-109)',
      ).toEqual([]);
    }
  });

  /**
   * **The needles have teeth** — every way of saying it that has been seen or measured,
   * including the two rewordings that passed the phrase-level guard and the declined forms
   * and verbs MUSE-109 measured escaping.
   */
  it('hr: every known phrasing of the instruction is caught', () => {
    for (const tooth of INSTRUCTIONS_HR) {
      const firing = instructsSubmission(tooth.text, 'hr');
      expect(
        firing,
        `no needle catches ${JSON.stringify(tooth.text)}, which instructs a submission`,
      ).not.toEqual([]);
      // Caught by the shape the tooth is *about*, so a sentence that happens to be
      // readable in the other word order is not standing in for the one being tested.
      expect(
        firing.map((hit) => hit.split(':')[0]),
        `${JSON.stringify(tooth.text)} is caught, but not by ${tooth.order}, which is ` +
          'the word order it is here to exercise',
      ).toContain(tooth.order);
    }
  });

  it('en: every known phrasing of the instruction is caught', () => {
    for (const tooth of INSTRUCTIONS_EN) {
      const firing = instructsSubmission(tooth.text, 'en');
      expect(
        firing,
        `no needle catches ${JSON.stringify(tooth.text)}, which instructs a submission`,
      ).not.toEqual([]);
      expect(
        firing.map((hit) => hit.split(':')[0]),
        `${JSON.stringify(tooth.text)} is caught, but not by ${tooth.order}, which is ` +
          'the word order it is here to exercise',
      ).toContain(tooth.order);
    }
  });

  /**
   * **And the teeth cover the needle rather than one corner of it** (MUSE-109).
   *
   * This is the criterion the ticket was filed on: MUSE-84's needle was green for a day
   * while „obrazac" was matched in exactly one of its seven case forms, because every
   * tooth in the set used the nominative or the accusative. A property over the labels
   * is the only thing that notices that — a list of sentences cannot say what it is
   * missing.
   */
  it('hr: a tooth exercises every case form of „obrazac" and both word orders', () => {
    const covered = new Set(INSTRUCTIONS_HR.map((tooth) => tooth.form));
    for (const form of SENTENCE_FORMS) {
      expect(
        covered,
        `no tooth uses the ${form} („${OBRAZAC_HR[form]}"). The needle set would be ` +
          'green against a single inflection again, which is MUSE-109 exactly',
      ).toContain(form);
    }

    for (const order of ['verbFirst', 'objectFirst'] as const) {
      const teeth = INSTRUCTIONS_HR.filter((tooth) => tooth.order === order);
      expect(teeth.length, `no tooth exercises ${order}`).toBeGreaterThan(0);
      // And with a declined form, not only with the one case the old needle covered:
      // „Obrazac ispuni" would have passed this whole block on its own.
      expect(
        teeth.some((tooth) => !['nominative', 'accusative'].includes(tooth.form)),
        `every ${order} tooth uses the nominative or the accusative, so that word order ` +
          'is only tested against the case form MUSE-84 already covered',
      ).toBe(true);
    }
  });

  it('a tooth exercises every verb the needle knows', () => {
    for (const verb of VERBS_HR) {
      const tooth = INSTRUCTIONS_HR.find((candidate) => candidate.verb === verb);
      expect(tooth, `no tooth exercises the Croatian verb “${verb}”`).toBeDefined();
      expect(
        new RegExp(verb, 'iu').test(tooth!.text),
        `the tooth labelled “${verb}” does not contain it: ${JSON.stringify(tooth!.text)}`,
      ).toBe(true);
    }
    for (const verb of VERBS_EN) {
      const tooth = INSTRUCTIONS_EN.find((candidate) => candidate.verb === verb);
      expect(tooth, `no tooth exercises the English verb “${verb}”`).toBeDefined();
      expect(
        new RegExp(`\\b${verb}\\b`, 'iu').test(tooth!.text),
        `the tooth labelled “${verb}” does not contain it: ${JSON.stringify(tooth!.text)}`,
      ).toBe(true);
    }
  });

  /**
   * **The object half, against the whole declension rather than against a sentence**
   * (MUSE-109). A tooth proves the needle catches one sentence; this proves the pattern
   * reaches every form of the word, including the ones no honest sentence would use, so
   * narrowing it back to a stem is a red test and not a ticket in six months.
   */
  it('hr: the object pattern matches every form of „obrazac"', () => {
    const object = new RegExp(`^${OBJECT_HR}$`, 'u');
    for (const [form, spelling] of Object.entries(OBRAZAC_HR)) {
      expect(
        object.test(spelling),
        `the needle's object does not match the ${form} („${spelling}"). „obrazac" ` +
          'loses its z in every oblique case, which is what MUSE-109 was filed about',
      ).toBe(true);
    }
  });

  it('en: a tooth puts a determiner between the verb and “form”', () => {
    expect(
      INSTRUCTIONS_EN.filter((tooth) => tooth.order === 'verbFirst' && tooth.determiner).length,
      'no tooth spends a gap slot on a determiner, which is the second thing MUSE-109 ' +
        'measured: "Send us a request in form." was caught and "Send us your request ' +
        'using the form below." escaped',
    ).toBeGreaterThan(0);
    for (const tooth of INSTRUCTIONS_EN) {
      if (tooth.determiner === null) continue;
      expect(
        new RegExp(`\\b${tooth.determiner}\\b[^\\p{L}\\d]+forms?\\b`, 'iu').test(tooth.text),
        `the tooth labelled “${tooth.determiner}” does not put it in front of “form”: ` +
          JSON.stringify(tooth.text),
      ).toBe(true);
    }
  });

  for (const locale of ['hr', 'en'] as const) {
    it(`${locale}: prose that legitimately names the form is not caught`, () => {
      for (const innocent of INNOCENT_FORM_PROSE.filter((entry) => entry.locale === locale)) {
        expect(
          instructsSubmission(innocent.text, locale),
          `a needle reads ${JSON.stringify(innocent.text)} as an instruction. It is ` +
            'true in the state that publishes it and has to stay on the page — widen the ' +
            'gap or the verb list rather than exempting it',
        ).toEqual([]);
      }
    });
  }

  /**
   * And the innocent prose is still *live*, which is what keeps the boundary above a
   * statement about this site rather than about fourteen strings in a test file
   * (`INNOCENT`'s reason, in `test/helpers/offer-claims.ts`).
   *
   * Each entry names the build that publishes it, because MUSE-110 gated two of them: the
   * „ostali u obrascu" pair is the *configured* build's failure copy and is correctly
   * absent from the one this site deploys.
   */
  it('the prose the boundary is drawn around is still published', async () => {
    for (const { route, build, text } of INNOCENT_FORM_PROSE) {
      // The raw document rather than its text: four of these are an attribute's value,
      // which stripping tags would throw away.
      const page = await pageMarkup(build === 'configured' ? configured : unconfigured, route);
      expect(
        page,
        `${route} no longer says ${JSON.stringify(text)} in the build with ` +
          `${build === 'configured' ? 'an endpoint' : 'no endpoint'} configured`,
      ).toContain(text);
    }
  });
});

/**
 * **MUSE-110 — the form's own failure copy describes the form that was actually built.**
 *
 * The defect: `failBody` told the visitor „Tvoji odgovori su ostali u obrascu, pa možeš
 * pokušati ponovno." / "Your answers are still in the form, so you can try again." and was
 * **not** gated on `FORM_HAS_PROCESSOR`, which gated only `/contact`'s hero (MUSE-84) and
 * `/privacy`'s recipient paragraphs (MUSE-72). With `PUBLIC_FORM_ENDPOINT` unset — the
 * live deploy, MUSE-12 — `TrialForm.astro` throws before any `fetch`, so that was the body
 * **every** visitor saw: an instruction to retry that cannot succeed on any attempt, on the
 * page whose hero had just said, correctly, that the form cannot be received. Measured in
 * `data-msg-fail-body` on `/`, `/contact` and `/pricing` in both locales — six pages,
 * byte-identical in both builds.
 *
 * It is MUSE-72's and MUSE-84's defect one surface further in, and it survived them both
 * because their guards read the hero, the `<meta name="description">`, `llms.txt` and the
 * notice, and never the form's own messages.
 *
 * **Both directions, against the two builds this file already performs.** With an endpoint
 * the retry wording is true and must come back; with none the honest body is the inbox and
 * no retry. Nothing here costs a heavyweight operation — `configured` and `unconfigured`
 * are the previews MUSE-15 needed and MUSE-72 and MUSE-84 reuse (`test/helpers/
 * concurrency.ts`, zero headroom).
 *
 * **The claim is a class, not the two sentences this ticket edited.** MUSE-84 measured what
 * a phrase-level guard is worth here: a guard whose every needle is the string being
 * deleted asserts "the old words are gone", so the next author reinstates the claim in
 * different words and the suite stays green. So the question asked below is *does any
 * message the browser can show tell the visitor to send or try again*, as a verb-and-adverb
 * adjacency in both word orders, and it is asked of **every** `data-msg-*` attribute on
 * every page that renders the form — derived from `ROUTES`, so a seventh page joins the
 * guard by existing.
 */
describe('MUSE-110: the failure copy describes the form that was actually built', () => {
  /**
   * **„Pošalji ponovno" — a send-or-try verb and „again", in either order.**
   *
   * The adverb is the half that cannot be left out of a retry instruction in either
   * language, and the verb list is what separates „pošalji ponovno" from the two innocent
   * uses of „ponovno" this site publishes. Written as alternatives with a right-hand
   * boundary rather than as a stem: `ponov[\p{L}]*` would also match „ponoviti", which is
   * `/aboutus`'s „ima vremena ponoviti isti korak" — *repeat*, not *retry*.
   *
   * **„ponovi" / "repeat" is deliberately not a verb here**, for the same sentence: that
   * page legitimately says there is time to repeat a step „i pitati ponovno ako nije" /
   * "and to ask again if it has not", which puts an innocent „ponovno" four words from an
   * innocent „ponoviti". Both halves of that are pinned below and asserted still live.
   *
   * **Negation is the boundary, and `MODAL_HR` is the half MUSE-84 did not need.** An
   * instruction and a statement that the thing cannot be done are the same verb and the
   * same adverb with „ne" between them, and in Croatian the negation attaches to the modal
   * rather than to the verb — „obrazac se **ne može** poslati ponovno" puts „ne" two words
   * in front of „poslati", where MUSE-84's single-word lookbehind cannot see it. Measured:
   * without `MODAL_HR` that sentence reads as an instruction. The modal list is closed and
   * short on purpose — „ne ide" is **not** in it, because „Ako i dalje ne ide, pošalji
   * ponovno." is an instruction and has to stay caught.
   *
   * English needs no modal rule: the participle „sent" is not the infinitive „send", so
   * "cannot be sent again" never matched. It gets the one thing Croatian has no safe
   * single word for instead — `oneWord`, for "resend" and "retry", which instruct a retry
   * with no adverb at all. „Ponovi" would be the Croatian equivalent and is the word
   * `/aboutus` uses for *repeat*.
   */
  const AGAIN_HR = String.raw`(?:ponovno|ponovo|opet|još\s+jednom)(?![\p{L}\d])`;
  const AGAIN_EN = String.raw`(?:again|once\s+more|one\s+more\s+time)(?![\p{L}\d])`;
  const MODAL_HR = String.raw`(?<!(?:${NEGATION_HR})[\s-](?:mož|smij|uspij|uspje)[\p{L}]*[\s-](?:se[\s-])?)`;
  const RETRY_VERB_HR = String.raw`(?<!(?:${NEGATION_HR})[\s-])${MODAL_HR}(?:pokuša|proba|pošalj|poslat|posla|predaj|predat|ispun|popun|prijav|klikn|stisn)[\p{L}]*`;
  const RETRY_VERB_EN = String.raw`(?<!(?:${NEGATION_EN})[\s-])\b(?:try|send|submit|fill|complete|press|click|tap)\b`;

  const RETRY = {
    hr: {
      verbFirst: new RegExp(
        String.raw`${RETRY_VERB_HR}${HR_STEP}{0,3}?[^\p{L}\d]+${AGAIN_HR}`,
        'iu',
      ),
      againFirst: new RegExp(
        String.raw`${AGAIN_HR}${HR_STEP}{0,2}?[^\p{L}\d]+${RETRY_VERB_HR}`,
        'iu',
      ),
    },
    en: {
      verbFirst: new RegExp(
        String.raw`${RETRY_VERB_EN}${EN_STEP}{0,3}?[^\p{L}\d]+${AGAIN_EN}`,
        'iu',
      ),
      againFirst: new RegExp(
        String.raw`${AGAIN_EN}${EN_STEP}{0,2}?[^\p{L}\d]+${RETRY_VERB_EN}`,
        'iu',
      ),
      oneWord: new RegExp(
        String.raw`(?<!(?:${NEGATION_EN})[\s-])\b(?:resend|retry|re-?submit|re-?send)\b`,
        'iu',
      ),
    },
  } as const;

  /** Every needle that fires on `text`, named, so a failure says which shape it was. */
  function instructsRetry(text: string, locale: Locale): string[] {
    return Object.entries(RETRY[locale])
      .filter(([, pattern]) => pattern.test(text))
      .map(([shape, pattern]) => `${shape}: ${JSON.stringify(pattern.exec(text)?.[0])}`);
  }

  /**
   * **The teeth.** The first three of each list are what the site published; the rest are
   * rewordings that say the same thing, including the word order Croatian makes free and
   * the two English words that need no adverb. A needle nobody has run against the
   * sentences it is for is the shape of defence this repository keeps re-filing.
   *
   * The last HR entry is the negation boundary from the other side: „ne ide" is a negation
   * and the sentence is still an instruction.
   */
  const RETRIES = {
    hr: [
      FORM_COPY.hr.failBody,
      FORM_COPY.hr.failOffline,
      FORM_COPY.hr.invalid,
      'Pokušaj ponovno.',
      'Probaj još jednom.',
      'Ponovno pošalji prijavu.',
      'Možeš poslati prijavu ponovno.',
      'Pošalji opet kad budeš mogla.',
      'Klikni ponovno na Pošalji.',
      'Ako i dalje ne ide, pošalji ponovno.',
    ],
    en: [
      FORM_COPY.en.failBody,
      FORM_COPY.en.failOffline,
      FORM_COPY.en.invalid,
      'Try again.',
      'Please resend the form.',
      'Submit it once more.',
      'Again, press send.',
      'You can retry.',
      'Try the form again later.',
    ],
  } as const;

  /**
   * **Prose that legitimately says „ponovno" / "again", and must not match** —
   * `INNOCENT_FORM_PROSE`'s pattern, and asserted *live* for its reason: a boundary tested
   * only against strings in a test file drifts away from the page it protects.
   *
   * `/aboutus`'s second paragraph is the measured case, in both locales. Then the copy this
   * ticket shipped and the `<noscript>` line beside it, read off the table rather than
   * quoted — both are the honest branch, and the needle has to leave them alone.
   */
  const INNOCENT_RETRY_PROSE = [
    {
      locale: 'hr',
      route: '/aboutus',
      text: 'Na satu ima vremena ponoviti isti korak dok ne sjedne, i pitati ponovno ako nije.',
    },
    {
      locale: 'en',
      route: '/en/aboutus',
      text: 'In class there is time to repeat a step until it settles, and to ask again if it has not.',
    },
    { locale: 'hr', route: '/contact', text: FORM_COPY.hr.undeliverable.fail },
    { locale: 'en', route: '/en/contact', text: FORM_COPY.en.undeliverable.fail },
    { locale: 'hr', route: '/contact', text: FORM_COPY.hr.undeliverable.invalid },
    { locale: 'en', route: '/en/contact', text: FORM_COPY.en.undeliverable.invalid },
    { locale: 'hr', route: '/contact', text: FORM_COPY.hr.noscript },
    { locale: 'en', route: '/en/contact', text: FORM_COPY.en.noscript },
  ] as const;

  /**
   * The negation boundary from the inside, and the only entries here that are not live.
   *
   * They are what an honest *statement* about the same mechanism looks like, and the
   * reason `MODAL_HR` exists. Nothing on the site says them today; if something does
   * tomorrow, the needle must already have been right about them.
   */
  const INNOCENT_NEGATIONS = {
    hr: [
      'Ovaj se obrazac ne može poslati ponovno.',
      'Ne možeš poslati ponovno.',
      'Ne smije se poslati ponovno.',
    ],
    en: ['This form cannot be sent again.', 'Do not send it again.'],
  } as const;

  const valueOf = (messages: Message[], name: string): string => {
    const found = messages.filter((message) => message.name === name);
    expect(found.length, `the form renders no data-msg-${name}`).toBeGreaterThan(0);
    return found[0]!.value;
  };

  const STATES = [
    { label: 'an endpoint configured', processor: true, preview: () => configured },
    { label: 'no endpoint configured', processor: false, preview: () => unconfigured },
  ] as const;

  for (const state of STATES) {
    it(`${state.label}: no message on any page says more than this build can do`, async () => {
      for (const { locale, route } of formPages) {
        const messages = messagesIn(await pageMarkup(state.preview(), route));
        expect(
          new Set(messages.map((message) => message.name)).size,
          `${route} renders ${messages.length} data-msg-* attributes, which is fewer than ` +
            'the form has messages — this guard is reading the wrong markup',
        ).toBeGreaterThanOrEqual(6);

        const instructing = messages
          .filter((message) => instructsRetry(message.value, locale).length > 0)
          .map((message) => `data-msg-${message.name}: ${JSON.stringify(message.value)}`);

        if (state.processor) {
          // An endpoint is configured, so a retry can reach somebody and the advice is
          // true again. Asserted as a class rather than as the two strings, so restoring
          // it in different words is still restoring it.
          expect(
            instructing,
            `${route} tells the visitor nothing about trying again, although this build ` +
              'has an endpoint and a retry can succeed',
          ).not.toEqual([]);
        } else {
          // The shipping state, and the one the defect was live in.
          expect(
            instructing,
            `${route} tells the visitor to send or try again on a build with no endpoint, ` +
              'where no attempt can succeed — the MUSE-110 defect, exactly. With no ' +
              'endpoint the only honest answer is the inbox',
          ).toEqual([]);
        }
      }
    });

    it(`${state.label}: the failure body is the one the configuration allows`, async () => {
      for (const { locale, route } of formPages) {
        const messages = messagesIn(await pageMarkup(state.preview(), route));
        const copy = FORM_COPY[locale];
        const body = valueOf(messages, 'fail-body');
        const offline = valueOf(messages, 'fail-offline');
        const invalid = valueOf(messages, 'invalid');

        if (state.processor) {
          expect(body, `${route}`).toBe(copy.failBody);
          expect(offline, `${route}`).toBe(copy.failOffline);
          expect(invalid, `${route}`).toBe(copy.invalid);
          // The split MUSE-15 made: one cause the visitor can act on, everything else in
          // one generic line. It only exists while something can be transmitted.
          expect(
            offline,
            'the two failure lines are the same string while an endpoint is configured, ' +
              'so being offline is no longer explained as the one thing to act on',
          ).not.toBe(body);
        } else {
          expect(body, `${route}`).toBe(copy.undeliverable.fail);
          expect(invalid, `${route}`).toBe(copy.undeliverable.invalid);
          /**
           * **With no endpoint the cause makes no difference, so there is one body.**
           *
           * Not a third state: the same gate, and in the off position the split MUSE-15
           * made has nothing to be about. Nothing is transmitted whether the visitor's
           * connection is up or down, so „check your connection and send again" is as
           * untrue as the generic retry — and the no-endpoint branch does reach it, which
           * is what `FAILURES`' last entry drives.
           */
          expect(
            offline,
            'the offline line is a different string with no endpoint configured, so one ' +
              'of the two is describing a submission this build cannot make',
          ).toBe(body);
        }
      }
    });
  }

  /**
   * **AC4 — the hero, the form and the `<noscript>` ask describe one mechanism.**
   *
   * The fourth surface is `/privacy`, which MUSE-72 holds to the same constant two
   * describes above. What this adds is that the three surfaces on `/contact` itself point
   * at the *same* inbox and that each sentence ends where the address begins, which is
   * `FormCopy['noscript']`'s convention and the whole of what "offers the inbox" means.
   */
  for (const { locale, route } of [
    { locale: 'hr' as const, route: '/contact' },
    { locale: 'en' as const, route: '/en/contact' },
  ]) {
    it(`${locale}: with no endpoint, every surface on /contact offers the one inbox`, async () => {
      const html = await pageMarkup(unconfigured, route);
      const addresses = new Set(
        [...html.matchAll(/mailto:([^"'?]+)/g)].map((match) => decodeEntities(match[1]!)),
      );
      expect(addresses.size, `/contact offers ${addresses.size} different addresses`).toBe(1);

      const hero = /<section[^>]*class="hero[^"]*"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1];
      const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1];
      const failMail = /<p[^>]*data-fail-mail[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1];
      for (const [surface, region] of [
        ['the hero', hero],
        ['the <noscript> block', noscript],
        ['the form’s failure block', failMail],
      ] as const) {
        expect(region, `${route} has no ${surface}`).toBeDefined();
        expect(region!, `${surface} does not offer the inbox`).toContain('mailto:');
      }

      // And the sentence each address follows ends in a colon rather than a full stop.
      const copy = FORM_COPY[locale];
      for (const sentence of [copy.undeliverable.fail, copy.noscript]) {
        expect(sentence.trimEnd().endsWith(':'), JSON.stringify(sentence)).toBe(true);
      }
    });
  }

  /**
   * **And the same claim where the visitor actually reads it** — the rendered alert, from
   * a real submit in a real browser on the build that has no endpoint.
   *
   * The markup assertions above are about what the page hands the script; this is what the
   * script writes. Both causes are driven, because the offline branch is reachable with no
   * endpoint (`send()` throws inside the `try`, so the `catch` still reads
   * `navigator.onLine`) — which is the half of this ticket that had to be checked rather
   * than assumed.
   */
  for (const target of TARGETS) {
    for (const failure of FAILURES.filter((candidate) => candidate.build === 'none')) {
      it(`${target.locale}, ${failure.label}: the alert instructs no retry and offers the inbox`, async () => {
        const seen = await failOnce(failure, target);
        const status = flatten(seen.status);

        expect(
          instructsRetry(status, target.locale),
          'the alert the visitor reads tells them to send or try again, on a build with ' +
            'no endpoint where no attempt can succeed (MUSE-110)',
        ).toEqual([]);
        expect(status, 'the alert says nothing at all about the failure').toContain(
          flatten(FORM_COPY[target.locale].undeliverable.fail),
        );
        // The way out, which is the only thing left that works.
        expect(seen.email, 'the page offered no address').toContain('@');
        expect(
          status,
          'the alert says what cannot be done without offering what can',
        ).toContain(seen.email);
      });
    }
  }

  it('an endpoint restores the retry wording where the visitor reads it', async () => {
    for (const target of TARGETS) {
      const server = FAILURES.find((candidate) => candidate.reply?.kind === 'error')!;
      const seen = await failOnce(server, target);
      expect(
        instructsRetry(flatten(seen.status), target.locale),
        'with an endpoint configured a retry can succeed, so the alert has to say so — ' +
          'gating a true sentence out is the same defect pointing the other way',
      ).not.toEqual([]);
    }
  });

  for (const locale of ['hr', 'en'] as const) {
    it(`${locale}: every known phrasing of a retry instruction is caught`, () => {
      for (const sentence of RETRIES[locale]) {
        expect(
          instructsRetry(sentence, locale),
          `no needle catches ${JSON.stringify(sentence)}, which instructs a retry`,
        ).not.toEqual([]);
      }
    });

    it(`${locale}: prose that legitimately says “again” is not caught`, () => {
      const innocent = [
        ...INNOCENT_RETRY_PROSE.filter((entry) => entry.locale === locale).map((e) => e.text),
        ...INNOCENT_NEGATIONS[locale],
      ];
      for (const sentence of innocent) {
        expect(
          instructsRetry(sentence, locale),
          `a needle reads ${JSON.stringify(sentence)} as a retry instruction. It says ` +
            'nothing a build without an endpoint cannot do — widen the verb list or the ' +
            'negation rule rather than exempting it',
        ).toEqual([]);
      }
    });
  }

  it('the prose the boundary is drawn around is still published', async () => {
    for (const { route, text } of INNOCENT_RETRY_PROSE) {
      const page = await pageMarkup(unconfigured, route);
      expect(page, `${route} no longer says ${JSON.stringify(text)}`).toContain(text);
    }
  });
});
