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
    const prose = ['invalid', 'requiredAny', 'tooLong', 'sentTitle', 'sentBody', 'failTitle', 'failBody', 'privacy', 'noscript'] as const;
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

  it('offers the same level values in both languages, with different labels', () => {
    expect(EN.levels.map((l) => l.value)).toEqual(HR.levels.map((l) => l.value));
    // The submitted value is language-independent, so the studio inbox reads the same
    // whichever site a person used.
    for (const [index, level] of HR.levels.entries()) {
      expect(EN.levels[index]!.label, `level ${level.value} label`).not.toBe(level.label);
    }
  });

  it('ends the two strings a link is appended to with a colon', () => {
    // `failBody` and `noscript` are both followed by the studio email address in the
    // markup. Without the colon the sentence reads as if it were finished.
    for (const copy of Object.values(FORM_COPY)) {
      expect(copy.failBody.trimEnd().endsWith(':')).toBe(true);
      expect(copy.noscript.trimEnd().endsWith(':')).toBe(true);
    }
  });
});
