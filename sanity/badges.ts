import type { DocumentBadgeComponent, DocumentBadgeDescription } from 'sanity';

import {
  formatLocalTime,
  MAX_WAIT_HOURS,
  nextRebuild,
} from '../src/lib/rebuild';

/**
 * **What Mina sees, and where (MUSE-21, AC2).**
 *
 * The acceptance criterion is that publishing is not followed by silence. A webhook could
 * have answered it with "your change is live now"; the scheduled rebuild cannot, and a
 * link to a GitHub Actions page was ruled out by the ticket in as many words — it is a
 * place a non-technical editor in Zagreb will never look and could not read if she did.
 *
 * So the answer is a different one: not *whether* it is building, but **when it will
 * appear**, stated as a ceiling she can plan around. That is strictly more useful than a
 * progress indicator, because it is true before she publishes as well as after, and it
 * needs no notification to reach her.
 *
 * It is a **document badge**, which Sanity renders in the document footer beside the
 * Publish button. Three alternatives were considered and are worse:
 *
 *   - *A pane in the sidebar.* She sees it when she opens the Studio and not when she
 *     presses the button, which is the one moment the question occurs to her.
 *   - *A field description.* It would have to be repeated on every document type, and a
 *     description about deployment sitting under a text field reads as noise.
 *   - *A custom publish action with a toast.* Wrapping Sanity's publish action to change
 *     what it says puts a fragile override on the single most important control in the
 *     Studio, to say something a badge says without the risk.
 *
 * The badge is computed in **her browser**, which is why it can name a clock time at all:
 * `nextRebuild` works in UTC and `formatLocalTime` renders in the viewer's own zone, so it
 * is right in Zagreb in both halves of the year with nothing configured. The *promise*
 * is still the duration — see `src/lib/rebuild.ts` for why a clock time must never be the
 * promise — and the time is offered as "oko", because the `schedule` event can be delayed.
 *
 * The copy is Croatian and has no English twin. That is the existing convention for Studio
 * chrome, not an omission: every title in `sanity/structure.ts` is Croatian too. The
 * bilingual rule is about *content*, which has two audiences; the Studio has one editor,
 * and a language switcher she will never use is a control to explain.
 *
 * The last sentence is the one that earns its place. The predictable failure here is not
 * that she waits — it is that she waits five minutes, decides it did not work, and
 * publishes again; so the badge tells her what to do instead, which is the only part of
 * this that a static "changes appear within six hours" could not.
 */
export function rebuildBadgeDescription(
  now: Date,
  timeZone?: string,
): DocumentBadgeDescription {
  const at = formatLocalTime(nextRebuild(now), timeZone);
  return {
    label: `Na stranici oko ${at}`,
    title:
      `Objava u Studiju ne mijenja stranicu odmah. Stranica se ponovno gradi svakih ` +
      `${MAX_WAIT_HOURS} h — sljedeći put oko ${at} po tvom vremenu — pa je sve ` +
      `objavljeno vidljivo najkasnije ${MAX_WAIT_HOURS} h nakon objave. Ako se ne ` +
      `pojavi ni tada, ne objavljuj ponovno nego javi da provjerimo.`,
    color: 'primary',
  };
}

/**
 * The badge as Sanity consumes it.
 *
 * Sanity calls this like a hook on every render of the document footer, so `new Date()` is
 * re-read often enough that the time stays current without a timer of our own. Kept as a
 * one-line wrapper so `rebuildBadgeDescription` is callable from a test without importing
 * `sanity` — which pulls in the whole editor and does not load under Node.
 */
export const rebuildBadge: DocumentBadgeComponent = () =>
  rebuildBadgeDescription(new Date());
