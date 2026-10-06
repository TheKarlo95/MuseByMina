import type { Locale } from './i18n';

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
 */
export const FORM_ENDPOINT: string = (import.meta.env.PUBLIC_FORM_ENDPOINT ?? '').trim();

export type FieldName = 'name' | 'email' | 'phone' | 'level' | 'message';

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
 * Formspark drops any submission whose `_gotcha` is non-empty, and the component
 * refuses to send one too — so a bot that fills every input it finds is stopped
 * without a CAPTCHA, a third-party script or a cookie.
 */
export const HONEYPOT_FIELD = '_gotcha';

export interface LevelOption {
  value: string;
  label: string;
}

export interface FormCopy {
  /** Accessible name for the `<form>` itself. */
  formLabel: string;
  labels: Record<FieldName, string>;
  /** Appended to the label of a field that may be left blank. */
  optional: string;
  hints: Partial<Record<FieldName, string>>;
  levels: readonly LevelOption[];
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
  /** Ends in a colon: the studio email address follows it as a link. */
  failBody: string;
  /** What happens to the data — GDPR Art. 13, in one sentence, beside the fields. */
  privacy: string;
  privacyLink: string;
  honeypotLabel: string;
  /** Ends in a colon: the studio email address follows it as a link. */
  noscript: string;
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
    },
    optional: 'neobavezno',
    hints: {
      phone: 'Ako ti je draže da te nazovemo.',
      level: 'Ne znaš? Ostavi kako je i predložit ćemo ti.',
      message: 'Dolaziš s nekim? Imaš pitanje? Napiši nam.',
    },
    levels: [
      { value: '', label: 'Još ne znam' },
      { value: 'pocetni', label: 'Početni' },
      { value: 'srednji', label: 'Srednji' },
      { value: 'napredni', label: 'Napredni' },
    ],
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
    privacy:
      'Ime, e-mail i broj telefona koristimo samo da ti odgovorimo i dogovorimo termin. Ne šaljemo newsletter i ne dijelimo ih ni s kim osim s uslugom koja prenosi obrazac.',
    privacyLink: 'Izjava o privatnosti',
    honeypotLabel: 'Ostavi ovo polje prazno',
    noscript:
      'Bez JavaScripta potvrda se prikazuje na stranici usluge koja prenosi obrazac, a ne ovdje. Možeš nam i pisati na:',
  },
  en: {
    formLabel: 'Trial class request',
    labels: {
      name: 'Full name',
      email: 'Email address',
      phone: 'Phone number',
      level: 'Level',
      message: 'Message',
    },
    optional: 'optional',
    hints: {
      phone: 'If you would rather we called you.',
      level: 'Not sure? Leave it as it is and we will suggest one.',
      message: 'Coming with someone? Got a question? Tell us.',
    },
    levels: [
      { value: '', label: 'Not sure yet' },
      { value: 'pocetni', label: 'Beginner' },
      { value: 'srednji', label: 'Intermediate' },
      { value: 'napredni', label: 'Advanced' },
    ],
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
    privacy:
      'We use your name, email and phone only to reply and arrange a time. No newsletter, and no sharing with anyone beyond the service that delivers the form.',
    privacyLink: 'Privacy notice',
    honeypotLabel: 'Leave this field empty',
    noscript:
      'Without JavaScript the confirmation appears on the form service’s own page rather than here. You can also write to us at:',
  },
};

/** The message shown when `field` is left blank. */
export function requiredMessage(copy: FormCopy, field: FieldName): string {
  return copy.required[field] ?? copy.requiredAny;
}
