import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_COPY, FORM_FIELDS, HONEYPOT_FIELD, requiredMessage } from '../src/lib/forms';
import type { FieldName, FormCopy } from '../src/lib/forms';
import { LOCALE_HTML_LANG, type Locale } from '../src/lib/i18n';
import { pagePath, startPreview, type Preview } from './helpers/preview';

/**
 * MUSE-7 — `/contact` and the trial-class form.
 *
 * Driven in a real browser rather than asserted against the built HTML, because every
 * acceptance criterion here is about *rendered* and *interactive* behaviour: a label
 * being visibly above its field is a geometry question, an error carrying an icon as
 * well as a colour is a computed-style question, and "without leaving the page" is only
 * meaningful if something actually submits.
 *
 * The form endpoint is a stub on the test server (see `helpers/preview.ts`), so the
 * success and failure paths are exercised for real. What a stub cannot prove — the
 * provider's CORS headers, its response shape, and whether a submission lands in the
 * studio inbox — needs credentials this suite does not have, and is called out in the PR
 * rather than asserted here.
 */

interface Target {
  locale: Locale;
  home: string;
  contact: string;
  privacy: string;
  copy: FormCopy;
  /** The other locale's copy — used to prove a page is not serving both. */
  other: FormCopy;
}

const TARGETS: Target[] = [
  {
    locale: 'hr',
    home: '/',
    contact: '/contact',
    privacy: '/privacy',
    copy: FORM_COPY.hr,
    other: FORM_COPY.en,
  },
  {
    locale: 'en',
    home: '/en',
    contact: '/en/contact',
    privacy: '/en/privacy',
    copy: FORM_COPY.en,
    other: FORM_COPY.hr,
  },
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
let preview: Preview;

beforeAll(async () => {
  [preview, browser] = await Promise.all([startPreview('contact'), chromium.launch()]);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await preview?.close();
});

interface Visit {
  page: Page;
  url: string;
  close(): Promise<void>;
}

async function visit(
  route: string,
  opts: { scheme?: 'dark' | 'light'; width?: number; height?: number } = {},
): Promise<Visit> {
  const ctx = await browser.newContext({
    colorScheme: opts.scheme ?? 'dark',
    // Same viewport the a11y gate uses, so a geometry claim here means the same thing there.
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
    // The Croatian homepage redirects a browser that is clearly not Croatian to /en
    // (`src/lib/lang.ts`). Without pinning the language, every assertion about `/` would
    // quietly be an assertion about `/en`.
    locale: route.startsWith('/en') ? 'en-GB' : 'hr-HR',
  });
  const page = await ctx.newPage();
  const url = preview.url(route);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return { page, url, close: () => ctx.close() };
}

/**
 * Wait for smooth scrolling to stop, without assuming it is on.
 *
 * The initial pause matters: polling immediately after the click reads the pre-scroll
 * position twice and concludes the page has settled at the top.
 */
async function settleScroll(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  let last = Number.NaN;
  for (let i = 0; i < 80; i += 1) {
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y === last) return;
    last = y;
    await page.waitForTimeout(25);
  }
}

async function fillForm(
  page: Page,
  values: Partial<Record<keyof typeof VALID, string>> = {},
): Promise<void> {
  const v = { ...VALID, ...values };
  await page.fill(`${FORM} [name="name"]`, v.name);
  await page.fill(`${FORM} [name="email"]`, v.email);
  await page.fill(`${FORM} [name="phone"]`, v.phone);
  await page.selectOption(`${FORM} [name="level"]`, v.level);
  await page.fill(`${FORM} [name="message"]`, v.message);
}

/** The resolved value of a role token, read in the form's own cascade context. */
async function roleColour(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.querySelector('[data-trial-form]')!.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

async function axeViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`);
}

/** Per-field DOM state, read in one pass so an assertion failure shows the whole picture. */
interface FieldState {
  name: string;
  tag: string;
  id: string;
  required: boolean;
  placeholder: string;
  labelCount: number;
  labelText: string;
  /** label.bottom - control.top; negative means the label sits above the field. */
  labelAboveBy: number;
  labelVisible: boolean;
  ariaInvalid: string | null;
  describedBy: string[];
  errorId: string;
  errorVisible: boolean;
  errorText: string;
  errorIcons: number;
  errorIconHidden: boolean;
  value: string;
}

function readFields(page: Page): Promise<FieldState[]> {
  return page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('[data-trial-form]')!;
    const controls = [
      ...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input, select, textarea',
      ),
    ].filter((el) => el.getClientRects().length > 0);

    return controls.map((el) => {
      const labels = [...form.querySelectorAll<HTMLLabelElement>(`label[for="${el.id}"]`)];
      const label = labels[0];
      const labelRect = label?.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const error = form.querySelector<HTMLElement>(`[data-error-for="${el.name}"]`);
      const text = error?.querySelector<HTMLElement>('[data-error-text]');
      const icons = error ? error.querySelectorAll('svg').length : 0;
      const icon = error?.querySelector('svg');

      return {
        name: el.name,
        tag: el.tagName.toLowerCase(),
        id: el.id,
        required: el.hasAttribute('required'),
        placeholder: el.getAttribute('placeholder') ?? '',
        labelCount: labels.length,
        labelText: (label?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        labelAboveBy: labelRect ? labelRect.bottom - rect.top : Number.NaN,
        labelVisible: !!labelRect && labelRect.width > 0 && labelRect.height > 0,
        ariaInvalid: el.getAttribute('aria-invalid'),
        describedBy: (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean),
        errorId: error?.id ?? '',
        errorVisible: !!error && error.getClientRects().length > 0,
        errorText: (text?.textContent ?? '').trim(),
        errorIcons: icons,
        errorIconHidden: icon?.getAttribute('aria-hidden') === 'true',
        value: el.value,
      };
    });
  });
}

function fieldOf(fields: FieldState[], name: FieldName): FieldState {
  const found = fields.find((f) => f.name === name);
  expect(found, `no rendered field named "${name}"`).toBeDefined();
  return found!;
}

/**
 * AC1 — Given the homepage, when I click any CTA, then I land on the `#trial` form with
 * it fully visible below the fixed header.
 *
 * "Fully visible below the fixed header" is read as: no part of the `#trial` block is
 * behind the fixed header, and the form's first field is wholly inside the viewport.
 * The block as a whole is taller than a laptop viewport — asserting it fits would be
 * asserting a different, smaller form than the one the ticket asks for.
 *
 * "Any CTA" was read off `a[href*="#trial"]`, which stopped meaning that in MUSE-16: the
 * locale switcher now carries the current fragment on its hrefs, so on a page whose hash
 * is `#trial` the two language links match too. They are not CTAs — following one is a
 * request to change language, and it lands on the *other* locale's page — so they are
 * excluded by the `data-locale` attribute only they carry.
 */
const TRIAL_CTA = 'a[href*="#trial"]:not([data-locale])';

describe('AC1: every CTA lands on #trial, clear of the fixed header', () => {
  for (const target of TARGETS) {
    it(`${target.locale}: every CTA on the homepage scrolls #trial clear of the header`, async () => {
      const { page, close } = await visit(target.home);
      try {
        // Guards the pin above: if the language redirect fires, this is the other page.
        expect(await page.evaluate(() => document.documentElement.lang)).toBe(
          LOCALE_HTML_LANG[target.locale],
        );

        const ctas = await page.$$eval(TRIAL_CTA, (els) =>
          els.map((el) => el.getAttribute('href') ?? ''),
        );
        // The header CTA and the hero CTA at minimum. A vacuous pass would be zero links.
        expect(ctas.length, 'CTAs pointing at #trial').toBeGreaterThanOrEqual(2);

        for (const [index] of ctas.entries()) {
          // Clear the fragment as well as the scroll position: clicking a link whose hash
          // is already current is not guaranteed to scroll again, which would make every
          // CTA after the first pass for free.
          await page.evaluate(() => {
            history.replaceState(null, '', location.pathname);
            window.scrollTo(0, 0);
          });
          const link = page.locator(TRIAL_CTA).nth(index);
          await link.click();
          await settleScroll(page);

          const geom = await page.evaluate(() => {
            const header = document.querySelector<HTMLElement>('[data-header]')!;
            const trial = document.querySelector<HTMLElement>('#trial')!;
            const control = document.querySelector<HTMLElement>('[data-trial-form] [name="name"]')!;
            const label = document.querySelector<HTMLElement>(
              `[data-trial-form] label[for="${control.id}"]`,
            )!;
            return {
              headerBottom: header.getBoundingClientRect().bottom,
              trialTop: trial.getBoundingClientRect().top,
              labelTop: label.getBoundingClientRect().top,
              controlBottom: control.getBoundingClientRect().bottom,
              viewport: window.innerHeight,
            };
          });

          expect(geom.trialTop, `CTA ${index}: #trial is under the header`).toBeGreaterThanOrEqual(
            geom.headerBottom,
          );
          expect(geom.labelTop, `CTA ${index}: first label is under the header`).toBeGreaterThan(
            geom.headerBottom,
          );
          expect(geom.controlBottom, `CTA ${index}: first field is off-screen`).toBeLessThanOrEqual(
            geom.viewport,
          );
        }
      } finally {
        await close();
      }
    });
  }
});

/**
 * AC2 — Given the form, then every field has a visible label above it — never
 * placeholder-only.
 */
describe('AC2: every field has a visible label above it', () => {
  for (const target of TARGETS) {
    it(`${target.locale}: labels are present, visible, above the field and in-language`, async () => {
      const { page, close } = await visit(target.contact);
      try {
        const fields = await readFields(page);
        expect(fields.map((f) => f.name).sort()).toEqual(FORM_FIELDS.map((f) => f.name).sort());

        for (const def of FORM_FIELDS) {
          const field = fieldOf(fields, def.name);
          expect(field.labelCount, `${def.name}: <label for> count`).toBe(1);
          expect(field.labelVisible, `${def.name}: label has no rendered box`).toBe(true);
          expect(field.labelText, `${def.name}: label text`).toContain(
            target.copy.labels[def.name],
          );
          // Above, not beside and not after: the label's bottom edge is at or over the
          // field's top edge.
          expect(field.labelAboveBy, `${def.name}: label is not above the field`).toBeLessThanOrEqual(
            1,
          );
          // A placeholder disappears the moment someone types, so it is never a label.
          // No field here carries one at all, which is the only version of this rule that
          // cannot rot.
          expect(field.placeholder, `${def.name}: has a placeholder`).toBe('');
          expect(field.required, `${def.name}: required attribute`).toBe(def.required);
        }
      } finally {
        await close();
      }
    });

    it(`${target.locale}: an optional field says so, and the page serves one language`, async () => {
      const { page, close } = await visit(target.contact);
      try {
        const fields = await readFields(page);
        for (const def of FORM_FIELDS.filter((f) => !f.required)) {
          expect(fieldOf(fields, def.name).labelText, `${def.name}: optional marker`).toContain(
            target.copy.optional,
          );
        }
        const formText = await page.textContent(FORM);
        expect(formText).toContain(target.copy.submit);
        expect(formText, 'the other locale leaked into this page').not.toContain(
          target.other.submit,
        );
      } finally {
        await close();
      }
    });
  }
});

/**
 * AC3 — Given a field with an error, then the error shows both an icon and text, never
 * colour alone.
 */
describe('AC3: errors carry an icon and text, not colour alone', () => {
  for (const target of TARGETS) {
    it(`${target.locale}: a blank required field reports itself with icon + text`, async () => {
      preview.requests.length = 0;
      const { page, url, close } = await visit(target.contact);
      try {
        await page.click('[data-submit]');
        await page.waitForSelector('[data-error-for="name"]:not([hidden])');

        const fields = await readFields(page);
        for (const def of FORM_FIELDS.filter((f) => f.required)) {
          const field = fieldOf(fields, def.name);
          expect(field.errorVisible, `${def.name}: error is not shown`).toBe(true);
          expect(field.errorText, `${def.name}: error text`).toBe(
            requiredMessage(target.copy, def.name),
          );
          expect(field.errorIcons, `${def.name}: error icon`).toBeGreaterThanOrEqual(1);
          expect(field.errorIconHidden, `${def.name}: icon is exposed to a screen reader`).toBe(
            true,
          );
          expect(field.ariaInvalid, `${def.name}: aria-invalid`).toBe('true');
          expect(field.describedBy, `${def.name}: aria-describedby omits the error`).toContain(
            field.errorId,
          );
        }

        // Optional fields left blank are not errors.
        for (const def of FORM_FIELDS.filter((f) => !f.required)) {
          const field = fieldOf(fields, def.name);
          expect(field.errorVisible, `${def.name}: blank optional field flagged`).toBe(false);
          expect(field.ariaInvalid, `${def.name}: aria-invalid on a valid field`).not.toBe('true');
        }

        // One alert, so a screen reader is told once that the submit was stopped.
        const status = page.locator('[data-form-status]');
        await expect.poll(() => status.isVisible()).toBe(true);
        expect(await status.textContent()).toContain(target.copy.invalid);
        expect(await status.getAttribute('role')).toBe('alert');

        // Focus goes to the first field that needs attention, and nothing navigated.
        expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe(
          'name',
        );
        expect(page.url()).toBe(url);
        expect(preview.requests, 'an invalid form was still sent').toHaveLength(0);
      } finally {
        await close();
      }
    });

    it(`${target.locale}: a malformed email and phone each get their own message`, async () => {
      preview.requests.length = 0;
      const { page, close } = await visit(target.contact);
      try {
        await fillForm(page, { email: 'ana.horvat@', phone: 'pozovi me' });
        await page.click('[data-submit]');
        await page.waitForSelector('[data-error-for="email"]:not([hidden])');

        const fields = await readFields(page);
        expect(fieldOf(fields, 'email').errorText).toBe(target.copy.format.email);
        expect(fieldOf(fields, 'phone').errorText).toBe(target.copy.format.phone);
        expect(preview.requests).toHaveLength(0);

        // Correcting a field clears its error without another submit.
        await page.fill(`${FORM} [name="email"]`, VALID.email);
        await expect.poll(() => page.locator('[data-error-for="email"]').isVisible()).toBe(false);
        const cleared = fieldOf(await readFields(page), 'email');
        expect(cleared.ariaInvalid).not.toBe('true');
        expect(cleared.describedBy).not.toContain(cleared.errorId);
      } finally {
        await close();
      }
    });

    it(`${target.locale}: a blank optional phone is accepted`, async () => {
      preview.requests.length = 0;
      preview.reply({ kind: 'ok' });
      const { page, close } = await visit(target.contact);
      try {
        await fillForm(page, { phone: '' });
        await page.click('[data-submit]');
        await page.waitForSelector('[data-sent]:not([hidden])');
        expect(preview.requests).toHaveLength(1);
      } finally {
        await close();
      }
    });
  }

  for (const scheme of ['dark', 'light'] as const) {
    it(`the error state is axe-clean in the ${scheme} theme`, async () => {
      const { page, close } = await visit('/contact', { scheme });
      try {
        await page.click('[data-submit]');
        await page.waitForSelector('[data-error-for="name"]:not([hidden])');
        // Errors are hidden at rest, so `npm run a11y` never sees them — this is the only
        // place the visible error state is audited.
        expect(await axeViolations(page)).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`an error reads as more than colour in the ${scheme} theme`, async () => {
      const { page, close } = await visit('/contact', { scheme });
      try {
        await page.click('[data-submit]');
        await page.waitForSelector('[data-error-for="name"]:not([hidden])');
        const seen = await page.evaluate(() => {
          const error = document.querySelector<HTMLElement>('[data-error-for="name"]')!;
          const text = error.querySelector<HTMLElement>('[data-error-text]')!;
          const icon = error.querySelector<SVGElement>('svg')!;
          return {
            colour: getComputedStyle(error).color,
            text: text.textContent?.trim() ?? '',
            iconBox: icon.getBoundingClientRect().width * icon.getBoundingClientRect().height,
          };
        });
        // Colour is present *as well* — it is the icon and the words that carry the meaning.
        expect(seen.colour).toBe(await roleColour(page, '--error'));
        expect(seen.text.length).toBeGreaterThan(0);
        expect(seen.iconBox).toBeGreaterThan(0);
      } finally {
        await close();
      }
    });
  }
});

/**
 * AC4 — Given a successful submit, then I see a confirmation in my own language without
 * leaving the page.
 */
describe('AC4: a successful submit confirms in-language, in place', () => {
  for (const target of TARGETS) {
    it(`${target.locale}: confirms without navigating, and sends what was typed`, async () => {
      preview.requests.length = 0;
      preview.reply({ kind: 'ok' });
      const { page, url, close } = await visit(target.contact);
      try {
        await fillForm(page);
        await page.click('[data-submit]');
        await page.waitForSelector('[data-sent]:not([hidden])');

        const sent = page.locator('[data-sent]');
        const text = (await sent.textContent()) ?? '';
        expect(text).toContain(target.copy.sentTitle);
        expect(text).toContain(target.copy.sentBody);
        expect(text, 'confirmed in the wrong language').not.toContain(target.other.sentTitle);

        expect(page.url(), 'the page navigated away').toBe(url);
        expect(await page.locator(FORM).isVisible(), 'the form is still showing').toBe(false);
        // Focus follows the confirmation, or a screen-reader user is left on a dead button.
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('trial-sent');

        expect(preview.requests).toHaveLength(1);
        const request = preview.requests[0]!;
        expect(request.method).toBe('POST');
        expect(request.contentType).toContain('application/json');
        expect(request.json).toMatchObject({
          name: VALID.name,
          email: VALID.email,
          phone: VALID.phone,
          level: VALID.level,
          message: VALID.message,
          [HONEYPOT_FIELD]: '',
        });
      } finally {
        await close();
      }
    });
  }

  for (const scheme of ['dark', 'light'] as const) {
    it(`the confirmation is axe-clean in the ${scheme} theme`, async () => {
      preview.reply({ kind: 'ok' });
      const { page, close } = await visit('/contact', { scheme });
      try {
        await fillForm(page);
        await page.click('[data-submit]');
        await page.waitForSelector('[data-sent]:not([hidden])');
        expect(await axeViolations(page)).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});

/**
 * AC5 — Given a failed submit, then I see what went wrong and my input is preserved.
 */
describe('AC5: a failed submit explains itself and keeps the answers', () => {
  const FAILURES = [
    { label: 'the endpoint rejects it', reply: { kind: 'error', status: 500 } as const, detail: '500' },
    { label: 'the connection drops', reply: { kind: 'drop' } as const, detail: '' },
  ];

  for (const target of TARGETS) {
    for (const failure of FAILURES) {
      it(`${target.locale}: ${failure.label} — message shown, input kept`, async () => {
        preview.requests.length = 0;
        preview.reply(failure.reply);
        const { page, url, close } = await visit(target.contact);
        try {
          await fillForm(page);
          await page.click('[data-submit]');
          await page.waitForSelector('[data-form-status]:not([hidden])');

          const status = page.locator('[data-form-status]');
          const text = (await status.textContent()) ?? '';
          expect(text).toContain(target.copy.failTitle);
          expect(text).toContain(target.copy.failBody);
          expect(text, 'failed in the wrong language').not.toContain(target.other.failTitle);

          // Something concrete about *what* went wrong, not just "an error occurred".
          const detail = (await page.locator('[data-fail-detail]').textContent()) ?? '';
          expect(detail.trim().length, 'no technical detail offered').toBeGreaterThan(0);
          if (failure.detail) expect(detail).toContain(failure.detail);

          // A way out that does not depend on the thing that just broke.
          expect(await status.locator('a[href^="mailto:"]').count()).toBeGreaterThanOrEqual(1);

          // Every answer is still there, and the form can be sent again.
          const fields = await readFields(page);
          expect(fieldOf(fields, 'name').value).toBe(VALID.name);
          expect(fieldOf(fields, 'email').value).toBe(VALID.email);
          expect(fieldOf(fields, 'phone').value).toBe(VALID.phone);
          expect(fieldOf(fields, 'level').value).toBe(VALID.level);
          expect(fieldOf(fields, 'message').value).toBe(VALID.message);

          expect(await page.locator(FORM).isVisible()).toBe(true);
          expect(await page.locator('[data-sent]').isVisible()).toBe(false);
          expect(await page.isDisabled('[data-submit]')).toBe(false);
          expect(await page.textContent('[data-submit]')).toContain(target.copy.submit);
          expect(page.url()).toBe(url);
        } finally {
          await close();
        }
      });
    }

    it(`${target.locale}: a retry after a failure goes through`, async () => {
      preview.requests.length = 0;
      preview.reply({ kind: 'error', status: 503 });
      const { page, close } = await visit(target.contact);
      try {
        await fillForm(page);
        await page.click('[data-submit]');
        await page.waitForSelector('[data-form-status]:not([hidden])');

        preview.reply({ kind: 'ok' });
        await page.click('[data-submit]');
        await page.waitForSelector('[data-sent]:not([hidden])');
        expect(preview.requests).toHaveLength(2);
        // The retry carries the same answers, not a half-cleared form.
        expect(preview.requests[1]!.json).toMatchObject({ name: VALID.name, email: VALID.email });
      } finally {
        await close();
      }
    });
  }
});

/**
 * AC6 — Given either theme, then the whole form is completable by keyboard alone.
 * (`npm run a11y` covers the axe half of this criterion for the page at rest; the error
 * and confirmation states are audited under AC3 and AC4 above.)
 */
describe('AC6: the form is completable by keyboard alone, in either theme', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: tab in, type, submit with Enter — no pointer used`, async () => {
      preview.requests.length = 0;
      preview.reply({ kind: 'ok' });
      const { page, close } = await visit('/contact', { scheme });
      try {
        const focusTrail: string[] = [];

        /** Tab until `predicate` matches the focused element, recording what was focused. */
        const tabTo = async (predicate: (id: string) => boolean, what: string) => {
          for (let i = 0; i < 60; i += 1) {
            const id = await page.evaluate(() => document.activeElement?.id ?? '');
            focusTrail.push(id);
            if (predicate(id)) return;
            await page.keyboard.press('Tab');
          }
          throw new Error(`never reached ${what} by Tab (trail: ${focusTrail.join(' → ')})`);
        };

        await page.evaluate(() => document.body.focus());
        await tabTo((id) => id.endsWith('-name'), 'the name field');
        await page.keyboard.type(VALID.name);
        await tabTo((id) => id.endsWith('-email'), 'the email field');
        await page.keyboard.type(VALID.email);
        await tabTo((id) => id.endsWith('-phone'), 'the phone field');
        await page.keyboard.type(VALID.phone);
        await tabTo((id) => id.endsWith('-level'), 'the level select');
        // A native select is driven by typing the option's first letters.
        await page.keyboard.press('ArrowDown');
        await tabTo((id) => id.endsWith('-message'), 'the message field');
        await page.keyboard.type(VALID.message);
        await tabTo((id) => id === 'trial-submit', 'the submit button');
        await page.keyboard.press('Enter');

        await page.waitForSelector('[data-sent]:not([hidden])');
        expect(preview.requests).toHaveLength(1);
        expect(preview.requests[0]!.json).toMatchObject({ name: VALID.name, email: VALID.email });
        // The level select was changed by keyboard, so it is not still the default.
        expect(preview.requests[0]!.json?.['level']).not.toBe('');

        // The honeypot must never be a stop on the way through the form.
        expect(focusTrail, 'the honeypot is in the tab order').not.toContain('trial-honeypot');
      } finally {
        await close();
      }
    });

    it(`${scheme}: a keyboard-focused field shows the 2px accent ring`, async () => {
      const { page, close } = await visit('/contact', { scheme });
      try {
        await page.focus(`${FORM} [name="name"]`);
        const accent = await roleColour(page, '--accent');
        const ring = await page.evaluate(() => {
          const style = getComputedStyle(document.querySelector('[data-trial-form] [name="name"]')!);
          return {
            width: style.outlineWidth,
            style: style.outlineStyle,
            colour: style.outlineColor,
            offset: style.outlineOffset,
          };
        });
        // Design system §11.2 — the ring is a role token, so it survives both themes.
        expect(ring.width).toBe('2px');
        expect(ring.style).toBe('solid');
        expect(ring.colour).toBe(accent);
        expect(ring.offset).toBe('2px');
      } finally {
        await close();
      }
    });
  }
});

/**
 * Design system §7.2 — the field styling is specified, not a matter of taste:
 * transparent background, bottom border only (1px `--line`), square corners, 48px tall;
 * focus is a 2px `--accent` bottom border plus the standard ring.
 */
describe('§7.2: field styling', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: every control is a 48px transparent square-cornered bottom rule`, async () => {
      const { page, close } = await visit('/contact', { scheme });
      try {
        const line = await roleColour(page, '--line');
        const styles = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-trial-form] input, [data-trial-form] select, [data-trial-form] textarea',
            ),
          ]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => {
              const s = getComputedStyle(el);
              return {
                name: el.getAttribute('name') ?? '',
                background: s.backgroundColor,
                top: s.borderTopWidth,
                right: s.borderRightWidth,
                bottom: s.borderBottomWidth,
                left: s.borderLeftWidth,
                bottomColour: s.borderBottomColor,
                radius: [
                  s.borderTopLeftRadius,
                  s.borderTopRightRadius,
                  s.borderBottomLeftRadius,
                  s.borderBottomRightRadius,
                ],
                height: el.getBoundingClientRect().height,
              };
            }),
        );

        expect(styles.length).toBe(FORM_FIELDS.length);
        for (const s of styles) {
          expect(s.background, `${s.name}: background is not transparent`).toBe('rgba(0, 0, 0, 0)');
          expect([s.top, s.right, s.left], `${s.name}: has a border other than the bottom`).toEqual([
            '0px',
            '0px',
            '0px',
          ]);
          expect(s.bottom, `${s.name}: bottom border width`).toBe('1px');
          expect(s.bottomColour, `${s.name}: bottom border is not --line`).toBe(line);
          expect(s.radius, `${s.name}: corners are not square`).toEqual([
            '0px',
            '0px',
            '0px',
            '0px',
          ]);
          expect(s.height, `${s.name}: shorter than 48px`).toBeGreaterThanOrEqual(48);
        }
      } finally {
        await close();
      }
    });

    it(`${scheme}: focus thickens the bottom border to 2px accent, corners stay square`, async () => {
      const { page, close } = await visit('/contact', { scheme });
      try {
        const accent = await roleColour(page, '--accent');
        await page.focus(`${FORM} [name="email"]`);
        // The border *colour* is transitioned (--dur-fast), so reading it straight after
        // focus reads the value it is animating away from, not the one being asserted.
        await page.waitForTimeout(400);
        const focused = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-trial-form] [name="email"]')!;
          const s = getComputedStyle(el);
          return {
            bottom: s.borderBottomWidth,
            colour: s.borderBottomColor,
            radius: s.borderBottomLeftRadius,
            height: el.getBoundingClientRect().height,
          };
        });
        expect(focused.bottom).toBe('2px');
        expect(focused.colour).toBe(accent);
        // base.css rounds the focus ring to 2px; §7.2 keeps the field itself square.
        expect(focused.radius).toBe('0px');
        // Thickening a border must not nudge the layout by a pixel.
        expect(focused.height).toBeGreaterThanOrEqual(48);
      } finally {
        await close();
      }
    });
  }
});

/**
 * Design system §10 — Croatian runs 20–25% longer than English, so nothing in this form
 * may be sized by anything but its own content.
 */
describe('§10: nothing in the form is sized to a fixed width', () => {
  it('the submit button and the labels grow with longer text instead of clipping', async () => {
    const { page, close } = await visit('/contact');
    try {
      const grown = await page.evaluate(() => {
        const measure = (el: HTMLElement) => {
          const before = el.getBoundingClientRect().width;
          el.textContent = `${el.textContent ?? ''} nadograđivanje individualni`;
          const after = el.getBoundingClientRect().width;
          return { before, after, clipped: el.scrollWidth > el.clientWidth + 1 };
        };
        const button = document.querySelector<HTMLElement>('[data-submit]')!;
        const label = document.querySelector<HTMLElement>('[data-trial-form] label')!;
        return { button: measure(button), label: measure(label) };
      });

      expect(grown.button.after, 'the submit button does not grow with its label').toBeGreaterThan(
        grown.button.before,
      );
      expect(grown.button.clipped, 'the submit button clips its label').toBe(false);
      expect(grown.label.clipped, 'a field label clips its text').toBe(false);
    } finally {
      await close();
    }
  });

  it('the form causes no sideways scrolling on a 360px phone', async () => {
    const { page, close } = await visit('/contact', { width: 360, height: 740 });
    try {
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        view: window.innerWidth,
      }));
      expect(overflow.doc).toBeLessThanOrEqual(overflow.view + 1);
    } finally {
      await close();
    }
  });
});

/**
 * GDPR — the form collects name, email and phone. The site stores nothing, but an inbox
 * is still processing and Croatia is in the EU, so the form has to say what happens to
 * the data and link somewhere that explains it. The nav deliberately has no privacy
 * entry, so the link lives in the footer.
 */
describe('GDPR: the form says what happens to the data, and links to a notice', () => {
  for (const target of TARGETS) {
    it(`${target.locale}: a privacy line sits with the fields and links to the notice`, async () => {
      const { page, close } = await visit(target.contact);
      try {
        const note = page.locator('[data-privacy-note]');
        expect(await note.isVisible()).toBe(true);
        expect(await note.textContent()).toContain(target.copy.privacy);

        const link = page.locator('[data-privacy-link]');
        expect(await link.count()).toBe(1);
        expect(await link.textContent()).toContain(target.copy.privacyLink);
        // The slashed spelling, not the one that 301s (MUSE-9).
        expect(new URL(await link.evaluate((el) => (el as HTMLAnchorElement).href)).pathname).toBe(
          pagePath(target.privacy),
        );
      } finally {
        await close();
      }
    });

    it(`${target.locale}: the privacy notice is a real page, reachable from the footer`, async () => {
      const { page, close } = await visit(target.privacy);
      try {
        expect(await page.locator('h1').count()).toBe(1);
        const body = (await page.textContent('main')) ?? '';
        // Not a stub: it has to name the data, the recipient and the way out.
        expect(body.length, 'the notice is a placeholder').toBeGreaterThan(600);
        expect(body).toContain('dancestudio.muse@gmail.com');
        expect(body).toContain('GDPR');
        expect(body, 'the processor that receives the form is not named').toContain('Formspark');
        expect(body, 'no supervisory authority named').toContain('AZOP');
      } finally {
        await close();
      }
    });
  }

  for (const target of TARGETS) {
    for (const route of [target.home, target.contact] as const) {
      it(`${target.locale}: ${route} links to the notice from the footer only`, async () => {
        const { page, close } = await visit(route);
        try {
          const href = pagePath(target.privacy);
          expect(
            await page.locator(`footer a[href="${href}"]`).count(),
            'no footer link to the privacy notice',
          ).toBeGreaterThanOrEqual(1);
          // The nav omits it on purpose — this is a footnote, not a destination.
          expect(await page.locator(`#primary-nav a[href="${href}"]`).count()).toBe(0);
        } finally {
          await close();
        }
      });
    }
  }
});

/**
 * Spam protection — a honeypot, because it needs no cookie, no third-party script and no
 * consent banner. See the PR for why that was chosen over Turnstile.
 */
describe('spam: the honeypot is invisible, unfocusable and fatal to a submit', () => {
  it('is present but has no rendered box and no place in the tab order', async () => {
    const { page, close } = await visit('/contact');
    try {
      const honeypot = await page.evaluate((name) => {
        const el = document.querySelector<HTMLInputElement>(`[data-trial-form] [name="${name}"]`);
        if (!el) return null;
        return {
          boxes: el.getClientRects().length,
          offsetParent: el.offsetParent !== null,
          tabIndex: el.tabIndex,
          /** A `hidden` ancestor keeps it out of the accessibility tree entirely. */
          hiddenAncestor: !!el.closest('[hidden]'),
        };
      }, HONEYPOT_FIELD);

      expect(honeypot, `no ${HONEYPOT_FIELD} field`).not.toBeNull();
      expect(honeypot!.boxes).toBe(0);
      expect(honeypot!.offsetParent).toBe(false);
      expect(honeypot!.hiddenAncestor).toBe(true);
    } finally {
      await close();
    }
  });

  it('swallows a filled-in submit without sending anything, and says nothing useful', async () => {
    preview.requests.length = 0;
    preview.reply({ kind: 'ok' });
    const { page, close } = await visit('/contact');
    try {
      await fillForm(page);
      await page.evaluate((name) => {
        const el = document.querySelector<HTMLInputElement>(`[data-trial-form] [name="${name}"]`)!;
        el.value = 'https://buy-cheap-things.example';
      }, HONEYPOT_FIELD);
      await page.click('[data-submit]');
      await page.waitForSelector('[data-sent]:not([hidden])');

      // A bot sees the same confirmation a person does, and the studio inbox sees nothing.
      expect(preview.requests, 'a honeypotted submission was forwarded').toHaveLength(0);
    } finally {
      await close();
    }
  });
});

/**
 * The homepage `#trial` block and `/contact` are the same component, so the conversion
 * path cannot drift between them.
 */
describe('the trial form is the same on the homepage and on /contact', () => {
  for (const target of TARGETS) {
    it(`${target.locale}: both routes render the same fields and submit the same way`, async () => {
      preview.requests.length = 0;
      preview.reply({ kind: 'ok' });

      const home = await visit(target.home);
      const contact = await visit(target.contact);
      try {
        for (const { page } of [home, contact]) {
          const fields = await readFields(page);
          expect(fields.map((f) => f.name)).toEqual(FORM_FIELDS.map((f) => f.name));
        }
        await fillForm(home.page);
        await home.page.click('[data-submit]');
        await home.page.waitForSelector('[data-sent]:not([hidden])');
        expect(preview.requests).toHaveLength(1);
      } finally {
        await home.close();
        await contact.close();
      }
    });
  }
});
