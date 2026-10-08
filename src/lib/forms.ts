import type { Locale } from './i18n';
import { LEVELS, LEVEL_NAME, type Level } from './schedule';

/**
 * The trial-class form: field model, endpoint and every user-facing string.
 *
 * One module rather than copy inside the component, for three reasons:
 *   - HR and EN are declared side by side, so a missing translation is visible
 *     rather than discovered by a Croatian visitor reading English;
 *   - the browser needs the validation messages at runtime, and the component
 *     hands them over as `data-msg-*` attributes it renders from this table —
 *     which keeps the `<script>` locale-agnostic and bundled (a `define:vars`
 *     script is inlined, and loses type checking);
 *   - the test suite can assert HR/EN parity without parsing markup.
 */

/**
 * Where submissions go — `https://submit-form.com/<form-id>` on Formspark.
 *
 * Env-driven for the same reason `SITE`/`BASE` are: rotating the form, or pointing a
 * staging build at a throwaway endpoint, must not be a code change. The id is public
 * (it ships inside the page), so `PUBLIC_` is correct and nothing here is a secret.
 *
 *   PUBLIC_FORM_ENDPOINT=https://submit-form.com/abc123 npm run build
 *
 * Unset — which is how CI and `npm test` build — the form still renders, still
 * validates and is still completable by keyboard; a submit reports that it could not
 * be delivered and points at the studio inbox. A form that silently swallowed a trial
 * request would be strictly worse than one that says it failed.
 *
 * It is **never** rendered as the `<form>`'s `action` (MUSE-15). The form submits by
 * `fetch` only, so this value is configuration for a script rather than a declared
 * navigation target, and the no-JavaScript path does not depend on it being set or on
 * what the provider does with a non-AJAX POST. See `TrialForm.astro`.
 */
export const FORM_ENDPOINT: string = (import.meta.env.PUBLIC_FORM_ENDPOINT ?? '').trim();

export type FieldName = 'name' | 'email' | 'phone' | 'level' | 'message' | 'package';

export interface FieldDef {
  /** Submitted name, element id suffix, and the key into every copy map below. */
  name: FieldName;
  kind: 'text' | 'email' | 'tel' | 'select' | 'textarea';
  required: boolean;
  /** Omitted for `level`, which no browser can autofill. */
  autocomplete?: string;
  maxlength?: number;
}

/**
 * Name and email are the only required fields.
 *
 * Phone is how most people here actually want to be reached, but making it mandatory
 * costs enquiries, and the ticket's job is the conversion path. Level is a `<select>`
 * that defaults to "not sure" — asking a beginner to self-assess is the fastest way
 * to lose them.
 */
export const FORM_FIELDS: readonly FieldDef[] = [
  { name: 'name', kind: 'text', required: true, autocomplete: 'name', maxlength: 120 },
  { name: 'email', kind: 'email', required: true, autocomplete: 'email', maxlength: 160 },
  { name: 'phone', kind: 'tel', required: false, autocomplete: 'tel', maxlength: 40 },
  { name: 'level', kind: 'select', required: false },
  { name: 'message', kind: 'textarea', required: false, maxlength: 2000 },
];

/**
 * **"Which package?" — the one field `/pricing` needs and the other two pages must not
 * grow** (MUSE-22).
 *
 * Deliberately *not* in `FORM_FIELDS`. `TrialForm.astro` renders it only when it is
 * handed a non-empty `packages` list, which is only on the pricing page: on `/` and
 * `/contact` there is nothing to choose from, and a `<select>` with one blank option is
 * a question the visitor cannot answer. `test/pricing.test.ts` renders the form with no
 * packages and asserts the field is absent, and it is the only thing that would catch
 * the mistake: `test/trialform.test.ts` subtracts every string in this table from what
 * `/contact` renders, so `packageAny` leaking onto that page is subtracted away and its
 * suite stays green. Measured, not assumed.
 *
 * **Extending the existing form rather than forking it** is the ticket's instruction and
 * the right call anyway: the validation, the honeypot, the single `role="alert"`, the
 * `method="dialog"` that makes the no-JavaScript 405 unreachable (MUSE-15) and the
 * failure copy that carries no diagnostics are all one implementation, and a second form
 * would be a second copy of all of it that drifts.
 *
 * Optional, and first in the list. Optional because somebody can enrol without having
 * settled on a package and should not be stopped; first because it is the thing they
 * just clicked, and a form that opens by confirming the choice reads as continuing an
 * action rather than starting a new one.
 */
export const PACKAGE_FIELD: FieldDef = { name: 'package', kind: 'select', required: false };

/**
 * Formspark drops any submission whose `_gotcha` is non-empty, and the component
 * refuses to send one too — so a bot that fills every input it finds is stopped
 * without a CAPTCHA, a third-party script or a cookie.
 */
export const HONEYPOT_FIELD = '_gotcha';

export interface LevelOption {
  /** Submitted value. Language-independent, so the studio inbox reads the same. */
  value: string;
  label: string;
  /**
   * Which level this option *is*, when it is one — the `data-level-name` contract.
   *
   * `TrialForm.astro` renders it onto the `<option>`, which is what brings the labels
   * inside MUSE-11's single-source guard: layers 1–2 of `test/home.test.ts` check every
   * element that declares a level and are blind to every element that does not, and
   * before MUSE-18 `grep -c data-level-name` on `/contact` returned 0. So relabelling
   * this select to `Novice` / `Expert` passed the whole suite — demonstrated on the
   * deployed site, which is why the attribute is here rather than a note asking the next
   * author to remember.
   *
   * Optional because the field is shared with the package `<select>` (MUSE-22), whose
   * options are `pricingTier` documents and are not levels — and because the blank
   * "not sure yet" option is not one either. An option without a level simply opts out
   * of the check, which is correct: there is no map to check it against.
   */
  level?: Level;
}

/**
 * The level `<select>`: "not sure yet" first, then the levels in `LEVELS` order.
 *
 * The blank default is deliberate (MUSE-7) — asking a beginner to self-assess is
 * the fastest way to lose them — and it is the only option with wording of its
 * own, because it is not a level.
 *
 * ---
 *
 * **The submitted value is the level key** (MUSE-18), and there is no longer a table
 * mapping one to the other.
 *
 * There was: `{ beginner: 'pocetni', improver: 'improver', intermediate: 'srednji',
 * advanced: 'napredni' }` — three Croatian slugs chosen before MUSE-6 settled on English
 * level names, plus the enum key, which MUSE-36 added when the real timetable brought a
 * fourth level. One list in two conventions, and the reason is worth keeping: nothing
 * guarded the wire format, so the author of the fourth entry had no way to see what the
 * other three were doing. A parallel table of strings with no single source above it is
 * the thing MUSE-11 removed for the display name and this is the same thing one field
 * over.
 *
 * So the key is the value. `LEVELS` is the vocabulary the Studio's dropdown, the GROQ
 * projection, the grid's row order and the homepage doors already speak, so
 * `level=intermediate` in the inbox maps back to a class on the timetable without a
 * translation step — and `test/home.test.ts` can assert the rendered `value` equals the
 * rendered `data-level-name`, which is only checkable because they are the same string.
 *
 * Changing a wire format is normally expensive and this was the one moment it is free:
 * `PUBLIC_FORM_ENDPOINT` is unset (MUSE-12 is parked), so no submission has ever carried
 * `pocetni` anywhere. A payload is now:
 *
 *   { name: 'Ana Horvat', email: 'ana@example.com', phone: '+385 91 234 5678',
 *     level: 'intermediate', message: '…', _gotcha: '' }
 *
 * with `level: ''` — not absent — for the visitor who left "not sure yet" alone, which
 * is the single most likely case and the reason the blank option exists.
 */
function levelOptions(locale: Locale, notSure: string): readonly LevelOption[] {
  return [
    { value: '', label: notSure },
    ...LEVELS.map((level) => ({ value: level, label: LEVEL_NAME[locale][level], level })),
  ];
}

export interface FormCopy {
  /** Accessible name for the `<form>` itself. */
  formLabel: string;
  labels: Record<FieldName, string>;
  /** Appended to the label of a field that may be left blank. */
  optional: string;
  hints: Partial<Record<FieldName, string>>;
  levels: readonly LevelOption[];
  /**
   * The blank first option of the package `<select>` — "no package chosen".
   *
   * The packages themselves are `pricingTier` documents and are passed in; this is the
   * only wording the field needs, and it is the counterpart of `levels[0]`: the one
   * option that is not one of the things being offered, so it is the one with prose of
   * its own.
   */
  packageAny: string;
  submit: string;
  sending: string;
  /** The single alert raised when validation stopped a submit. */
  invalid: string;
  /** Used when a field has no message of its own. */
  requiredAny: string;
  required: Partial<Record<FieldName, string>>;
  format: Partial<Record<FieldName, string>>;
  tooLong: string;
  sentTitle: string;
  sentBody: string;
  failTitle: string;
  /**
   * The one line every failure the visitor cannot act on gets — a misconfigured
   * endpoint, a 500, a CORS rejection, a provider that has gone away (MUSE-15).
   *
   * Deliberately generic, and deliberately the *only* thing said about the cause. The
   * block used to end with `Error.message`, so a Croatian visitor read three localised
   * sentences and then `PUBLIC_FORM_ENDPOINT is not configured`. Enumerating statuses
   * here would be the same mistake with better manners: "error 500" is not information
   * a visitor can use, and it is not translatable prose either.
   *
   * Ends in a colon: the studio email address follows it as a link.
   */
  failBody: string;
  /**
   * The one failure the visitor *can* do something about: their network is down.
   *
   * Split from `failBody` because the actions differ — "check your connection and send
   * again" is useful advice exactly once, and useless noise for a 500. The signal is
   * `navigator.onLine === false`, which is the only one that reliably means this; a
   * fetch `TypeError` also covers CORS and a dead provider.
   *
   * Ends in a colon: the studio email address follows it as a link.
   */
  failOffline: string;
  /** What happens to the data — GDPR Art. 13, in one sentence, beside the fields. */
  privacy: string;
  privacyLink: string;
  honeypotLabel: string;
  /**
   * What a visitor without JavaScript is told, and the only thing they are offered.
   *
   * It used to say the confirmation would appear on the form service's own page, which
   * was false as shipped: the form had no `action`, so the native POST went to the page
   * itself and GitHub Pages answered `405 Not Allowed` with everything typed thrown away
   * (MUSE-15). The form is now not shown at all without JavaScript — see the
   * `scripting: none` rule in `TrialForm.astro` — so this copy has to be the whole
   * alternative rather than a footnote to a form.
   *
   * Ends in a colon: the studio email address follows it as a link.
   */
  noscript: string;
  /** What to put in that email, so the first reply can already offer a time. */
  noscriptAsk: string;
}

export const FORM_COPY: Record<Locale, FormCopy> = {
  hr: {
    formLabel: 'Prijava za probni sat',
    labels: {
      name: 'Ime i prezime',
      email: 'E-mail adresa',
      phone: 'Broj telefona',
      level: 'Razina',
      message: 'Poruka',
      package: 'Paket',
    },
    optional: 'neobavezno',
    hints: {
      phone: 'Ako ti je draže da te nazovemo.',
      level: 'Ne znaš? Ostavi kako je i predložit ćemo ti.',
      message: 'Dolaziš s nekim? Imaš pitanje? Napiši nam.',
      package: 'Možeš promijeniti ili ostaviti neodabrano.',
    },
    levels: levelOptions('hr', 'Još ne znam'),
    packageAny: 'Bez odabranog paketa',
    submit: 'Pošalji prijavu',
    sending: 'Šaljem…',
    invalid: 'Provjeri označena polja i pošalji ponovno.',
    requiredAny: 'Ovo polje je obavezno.',
    required: {
      name: 'Upiši ime da znamo kako te zvati.',
      email: 'Upiši e-mail adresu — na nju ti odgovaramo.',
    },
    format: {
      email: 'Ova e-mail adresa izgleda nepotpuno. Provjeri ima li @ i domenu.',
      phone: 'Broj telefona smije sadržavati samo cifre, razmake i znak +.',
    },
    tooLong: 'Poruka je predugačka — skrati je, molimo.',
    sentTitle: 'Prijava je poslana.',
    sentBody:
      'Javljamo se u roku od jednog radnog dana s terminom za probni sat. Ako ne vidiš naš odgovor, provjeri spam mapu.',
    failTitle: 'Prijava nije poslana.',
    failBody:
      'Tvoji odgovori su ostali u obrascu, pa možeš pokušati ponovno. Ako i dalje ne ide, piši nam na:',
    failOffline:
      'Izgleda da trenutno nema internetske veze. Tvoji odgovori su ostali u obrascu — provjeri vezu i pošalji ponovno. Možeš nam i pisati na:',
    privacy:
      'Ime, e-mail i broj telefona koristimo samo da ti odgovorimo i dogovorimo termin. Ne šaljemo newsletter i ne dijelimo ih ni s kim osim s uslugom koja prenosi obrazac.',
    privacyLink: 'Izjava o privatnosti',
    honeypotLabel: 'Ostavi ovo polje prazno',
    noscript:
      'Bez JavaScripta ovaj se obrazac ne može poslati, pa ga ovdje i ne prikazujemo. Prijavu nam pošalji e-mailom na:',
    noscriptAsk:
      'Napiši ime, razinu ako je već znaš i kad ti otprilike odgovara. Odgovaramo u roku od jednog radnog dana.',
  },
  en: {
    formLabel: 'Trial class request',
    labels: {
      name: 'Full name',
      email: 'Email address',
      phone: 'Phone number',
      level: 'Level',
      message: 'Message',
      package: 'Package',
    },
    optional: 'optional',
    hints: {
      phone: 'If you would rather we called you.',
      level: 'Not sure? Leave it as it is and we will suggest one.',
      message: 'Coming with someone? Got a question? Tell us.',
      package: 'You can change this, or leave it unset.',
    },
    levels: levelOptions('en', 'Not sure yet'),
    packageAny: 'No package chosen',
    submit: 'Send my request',
    sending: 'Sending…',
    invalid: 'Check the marked fields and send again.',
    requiredAny: 'This field is required.',
    required: {
      name: 'Tell us your name so we know what to call you.',
      email: 'We need an email address to reply to.',
    },
    format: {
      email: 'This email address looks incomplete. Check for an @ and a domain.',
      phone: 'A phone number can only contain digits, spaces and a +.',
    },
    tooLong: 'That message is too long — please shorten it.',
    sentTitle: 'Your request is on its way.',
    sentBody:
      'We reply within one working day with a slot for your trial class. If you do not see our answer, check your spam folder.',
    failTitle: 'That did not send.',
    failBody:
      'Your answers are still in the form, so you can try again. If it still will not go through, write to us at:',
    failOffline:
      'You appear to be offline. Your answers are still in the form — check your connection and send again. You can also write to us at:',
    privacy:
      'We use your name, email and phone only to reply and arrange a time. No newsletter, and no sharing with anyone beyond the service that delivers the form.',
    privacyLink: 'Privacy notice',
    honeypotLabel: 'Leave this field empty',
    noscript:
      'Without JavaScript this form cannot be sent, so we do not show it here. Send your request by email instead, to:',
    noscriptAsk:
      'Tell us your name, your level if you already know it, and roughly when suits you. We reply within one working day.',
  },
};

/** The message shown when `field` is left blank. */
export function requiredMessage(copy: FormCopy, field: FieldName): string {
  return copy.required[field] ?? copy.requiredAny;
}
