import { describe, expect, it } from 'vitest';

import { FORM_COPY, FORM_FIELDS, requiredMessage } from '../src/lib/forms';
import { LOCALES } from '../src/lib/i18n';

/**
 * MUSE-7 — "every user-facing string needs both HR and EN".
 *
 * A browser test can only catch a missing translation on a string it happens to render.
 * This walks the table instead, so a message that only appears after a 503 is covered the
 * same as a label. It compares the two locales structurally — same keys, same option
 * values, different words — rather than asserting any particular wording.
 */
const [HR, EN] = [FORM_COPY.hr, FORM_COPY.en];

/** Every leaf string in the copy table, keyed by dotted path. */
function leaves(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'string') {
    out.set(path, value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const [key, leaf] of leaves(item, `${path}[${index}]`)) out.set(key, leaf);
    });
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      for (const [sub, leaf] of leaves(item, path ? `${path}.${key}` : key)) out.set(sub, leaf);
    }
  }
  return out;
}

describe('the form copy table', () => {
  it('has an entry for every locale the site declares', () => {
    expect(Object.keys(FORM_COPY).sort()).toEqual([...LOCALES].sort());
  });

  it('declares exactly the same strings in HR and EN', () => {
    expect([...leaves(EN).keys()].sort()).toEqual([...leaves(HR).keys()].sort());
  });

  it('leaves none of them blank', () => {
    for (const copy of Object.values(FORM_COPY)) {
      for (const [path, text] of leaves(copy)) {
        // `levels[0].value` is intentionally the empty "not sure yet" option.
        if (/^levels\[\d+]\.value$/.test(path)) continue;
        expect(text.trim(), `${path} is empty`).not.toBe('');
      }
    }
  });

  it('actually translates the prose rather than reusing the English', () => {
    // Labels like "Level"/"Razina" are short enough to coincide in principle; the
    // sentences are not, and those are where an untranslated string hides.
    const prose = [
      'invalid',
      'requiredAny',
      'tooLong',
      'sentTitle',
      'sentBody',
      'failTitle',
      'failBody',
      'failOffline',
      'privacy',
      'noscript',
      'noscriptAsk',
    ] as const;
    for (const key of prose) {
      expect(EN[key], `${key} is the same in both languages`).not.toBe(HR[key]);
    }
  });

  it('has a message for every field that can be left blank by mistake', () => {
    for (const field of FORM_FIELDS.filter((f) => f.required)) {
      for (const copy of Object.values(FORM_COPY)) {
        expect(requiredMessage(copy, field.name).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has a format message for every field whose format is validated', () => {
    // email and tel are the two the component format-checks; a missing message there
    // means a field silently refuses to submit with nothing shown.
    for (const field of FORM_FIELDS.filter((f) => f.kind === 'email' || f.kind === 'tel')) {
      for (const copy of Object.values(FORM_COPY)) {
        expect(copy.format[field.name], `format message for ${field.name}`).toBeTruthy();
      }
    }
  });

  it('offers the same level values in both languages', () => {
    // The submitted value is language-independent, so the studio inbox reads the same
    // whichever site a person used.
    expect(EN.levels.map((l) => l.value)).toEqual(HR.levels.map((l) => l.value));
  });

  it('labels the levels the same way in both, and translates the one that is prose', () => {
    // These labels used to be required to *differ*, which was the pre-MUSE-6 rule.
    // A level renders English in both locales, and since MUSE-11 both locales read it
    // from `LEVEL_NAME` — so the three level labels are the same words on purpose,
    // and the Croatian form no longer says `Početni` while `/schedule` says `Beginner`.
    const [hrNotSure, ...hrLevels] = HR.levels;
    const [enNotSure, ...enLevels] = EN.levels;

    expect(hrLevels.length, 'the three levels are missing from the select').toBe(3);
    expect(enLevels.map((l) => l.label)).toEqual(hrLevels.map((l) => l.label));

    // "Još ne znam" / "Not sure yet" is not a level. It is prose, so it is translated.
    expect(hrNotSure!.value, 'the default option is the blank one').toBe('');
    expect(enNotSure!.label, 'the "not sure yet" option is not translated').not.toBe(
      hrNotSure!.label,
    );
  });

  it('ends every string a link is appended to with a colon', () => {
    // `failBody`, `failOffline` and `noscript` are each followed by the studio email
    // address in the markup. Without the colon the sentence reads as if it were finished.
    for (const copy of Object.values(FORM_COPY)) {
      for (const key of ['failBody', 'failOffline', 'noscript'] as const) {
        expect(copy[key].trimEnd().endsWith(':'), key).toBe(true);
      }
    }
  });

  it('says nothing in the failure lines about what technically failed', () => {
    /**
     * MUSE-15 — the failure block used to end with `Error.message`, so the Croatian page
     * read `PUBLIC_FORM_ENDPOINT is not configured` / `HTTP 500 Internal Server Error`.
     * The fix is not to translate those: a status code is not information a visitor can
     * act on, and copy that enumerates them dates the moment a provider changes one.
     * `test/trialform.test.ts` proves no diagnostic is *rendered*; this keeps one out of
     * the copy table, which is the other way it could come back.
     */
    for (const copy of Object.values(FORM_COPY)) {
      for (const key of ['failTitle', 'failBody', 'failOffline'] as const) {
        expect(copy[key], `${key} names an HTTP status`).not.toMatch(/\b[1-5]\d\d\b/);
        expect(copy[key], `${key} names a build-time variable`).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
      }
    }
  });
});
