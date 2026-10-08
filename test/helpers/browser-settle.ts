import type { Page } from 'playwright';

/**
 * **Waiting for a condition instead of for the clock (MUSE-54).**
 *
 * Three browser suites flaked on the same afternoon, in three different costumes:
 * `test/localeswitch.test.ts`'s middle-click case, `test/contact.test.ts`'s CTA scroll
 * position, `test/trialform.test.ts`'s status block. None of them shared a line of code
 * and all of them had the same defect — **a measurement taken at a moment rather than
 * after a condition.** A fixed sleep is the obvious form of it; a poll that samples from
 * the test process at a fixed interval is the same bet wearing a loop, and a scroll
 * assertion read "soon after" a click is the same bet with no wait at all.
 *
 * `npm test` runs ten real `astro build`s in parallel workers and several Chromium
 * instances beside them, and several agents doing that at once in separate worktrees is
 * the normal operating mode of this repo rather than a load spike. So the question a wait
 * has to answer is not "has 150 ms passed" but "has the browser finished".
 *
 * ## Why frames and not milliseconds
 *
 * Everything these suites wait for — a smooth scroll, a CSS transition — is **produced by
 * the browser's frame clock**. On a loaded box frames are slow, and the animation and our
 * sampling of it slow down *together*. That is the property a wall clock does not have:
 *
 *   - The old `settleScroll` read `window.scrollY` from Node every 25 ms and returned when
 *     two reads matched. Under contention a starved frame means the position is unchanged
 *     between two samples **while the scroll is still mid-flight**, so it returned early
 *     and the caller measured the geometry of a page halfway down. That is MUSE-50's
 *     contact failure exactly.
 *   - It also rounded the position to whole pixels, which hides the sub-pixel crawl at the
 *     end of an eased scroll — the most likely place to sample two equal values.
 *   - And when its 80 iterations ran out it **returned normally**, so a scroll that took
 *     longer than ~2.1 s was reported as settled.
 *
 * Sampling on `requestAnimationFrame` inside the page fixes all three: a position that is
 * byte-identical across several consecutive frames is a scroll that has stopped, whether
 * those frames took 16 ms or two seconds each, and there is no CDP round trip in the
 * sampling loop to add jitter of its own.
 *
 * `minFrames` is the frame-clock version of the 150 ms pause the old helper opened with,
 * and it is there for the same reason: a scroll that has not *started* yet also looks
 * perfectly still. Expressed in frames it scales with load instead of betting against it.
 *
 * ## The wall clock is only on the failure path
 *
 * Every wait here takes a `timeout`, and that is deliberately the *only* place a duration
 * appears: it bounds how long a failure takes to report, never whether a success is
 * believed. A condition that never arrives therefore fails naming what was awaited and
 * what it last saw, rather than as a bare timeout somebody will re-run (MUSE-54 AC3).
 */

/** What the frame loop samples. */
export type Probe =
  /** The scroll position of the document. */
  | { kind: 'scroll' }
  /**
   * The animations and CSS transitions running on one element.
   *
   * `Element.getAnimations()` reports transitions as well as animations in Chromium, so
   * "none of them is running" is the end of the transition itself rather than a guess at
   * how long `--dur-fast` is.
   */
  | { kind: 'animations'; selector: string }
  /**
   * Nothing. Resolves once the page has produced `minFrames` frames.
   *
   * For the assertions that are *negative* — "activating this did not navigate" — where
   * there is no state to converge on and the only honest question is whether the browser
   * has had its own chance to act. Frames rather than milliseconds matters most here: on
   * a loaded box a 500 ms sleep can be zero frames, and zero frames is no chance at all.
   */
  | { kind: 'frames' };

export interface SettleOptions {
  /** Consecutive frames the sample must be unchanged for. */
  quietFrames?: number;
  /** Frames to observe before any verdict, so a slow start cannot read as a finish. */
  minFrames?: number;
  /** Failure-path budget, in milliseconds. Never consulted on the way to a success. */
  timeout?: number;
}

const DEFAULTS = { quietFrames: 6, minFrames: 10, timeout: 20_000 } as const;

/**
 * Wait, in the page's own frame clock, until `probe` reports the same thing for
 * `quietFrames` consecutive frames — having watched at least `minFrames` of them.
 *
 * `what` is the condition in words, and it is required: it is what the failure says.
 */
export async function settle(
  page: Page,
  probe: Probe,
  what: string,
  options: SettleOptions = {},
): Promise<void> {
  const quietFrames = options.quietFrames ?? DEFAULTS.quietFrames;
  const minFrames = options.minFrames ?? DEFAULTS.minFrames;
  const timeout = options.timeout ?? DEFAULTS.timeout;

  await page.evaluate(
    (input) =>
      new Promise<void>((resolve, reject) => {
        /** One sample: how things look, and whether they look finished. */
        const read = (): { value: string; done: boolean } => {
          if (input.probe.kind === 'frames') return { value: '', done: true };
          if (input.probe.kind === 'scroll') {
            // Unrounded on purpose: the last frames of an eased scroll move by fractions
            // of a pixel, and rounding is what let two samples match mid-flight.
            return { value: `at ${window.scrollX},${window.scrollY}`, done: true };
          }
          const el = document.querySelector(input.probe.selector);
          if (el === null) {
            return { value: `no element matching ${input.probe.selector}`, done: false };
          }
          const running = (typeof el.getAnimations === 'function' ? el.getAnimations() : [])
            .filter((animation) => animation.playState === 'running')
            .map((animation) => Math.round(Number(animation.currentTime ?? 0)));
          return {
            value: `${running.length} still running (${running.join(', ')})`,
            done: running.length === 0,
          };
        };

        const started = performance.now();
        let frames = 0;
        let quietFor = 0;
        let last: string | null = null;

        const tick = (): void => {
          frames += 1;
          const { value, done } = read();
          quietFor = value === last ? quietFor + 1 : 0;
          last = value;

          if (done && frames >= input.minFrames && quietFor >= input.quietFrames) {
            resolve();
            return;
          }
          const spent = Math.round(performance.now() - started);
          if (spent > input.timeout) {
            reject(
              new Error(
                `gave up waiting for ${input.what}: ${frames} frames and ${spent}ms in, ` +
                  `the page is ${value}`,
              ),
            );
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { probe, what, quietFrames, minFrames, timeout },
  );
}

/**
 * Wait for scrolling to stop — including a scroll that has not begun yet.
 *
 * Replaces the three hand-written copies of a 150 ms-then-poll-every-25 ms helper that
 * `test/contact.test.ts`, `test/lang.test.ts` and `test/localeswitch.test.ts` each carried
 * (MUSE-54). One copy, and the copy waits on the frame clock. `scroll-behavior: smooth` is
 * set on the document (`src/styles/base.css`), so a hash navigation animates and there is
 * genuinely something to wait for.
 */
export function settleScroll(page: Page, options: SettleOptions = {}): Promise<void> {
  return settle(page, { kind: 'scroll' }, 'the page to stop scrolling', options);
}

/**
 * Wait for every transition and animation on `selector` to finish.
 *
 * The condition a `--dur-fast` sleep was approximating. Reading a transitioned property
 * straight after the event that starts it reads the value being animated *away from*, and
 * the fix is not a longer sleep: it is asking the element whether it is still moving.
 *
 * Deliberately not "wait until the colour is the one I am about to assert" — that would
 * make the assertion a tautology and the test toothless.
 */
export function settleAnimations(
  page: Page,
  selector: string,
  options: SettleOptions = {},
): Promise<void> {
  return settle(
    page,
    { kind: 'animations', selector },
    `the transitions on ${selector} to finish`,
    options,
  );
}

/**
 * Wait until a document has finished loading — and is therefore not going to hop again.
 *
 * This is the condition behind the "long enough that a second hop would have started"
 * sleeps in `test/localeswitch.test.ts`. `langInitScript` (`src/lib/lang.ts`) is a
 * **blocking inline script in `<head>`**, so whatever it is going to do it has already
 * done before the body is parsed, and therefore before `load` can fire on that document.
 * "This document is complete" is thus a *proof* that it stayed, where 200 ms was a guess
 * that a redirect would have been quick about it.
 *
 * `waitForLoadState` resolves immediately when the page is already loaded and waits for
 * the new document when a navigation is in flight, so a hop that was still mid-air when
 * the caller's `goto` resolved is waited out rather than raced.
 */
export async function settleNavigation(
  page: Page,
  what: string,
  options: { timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULTS.timeout;
  await awaiting(what, () => page.waitForLoadState('load', { timeout }));
  await awaiting(what, () =>
    page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout }),
  );
}

/**
 * Wait for the browser to have had its chance to act on an interaction, for the
 * assertions that are about something *not* happening.
 *
 * A negative claim has no state to converge on, so this gives it the two conditions it can
 * actually have:
 *
 *   1. **Frames.** The page produces real frames, so the click's default action and any
 *      handler have run. If the interaction *did* navigate, the in-page wait dies with its
 *      execution context — which is swallowed here on purpose, because the caller's own
 *      navigation counters are the assertion and they give a far better message than
 *      "Execution context was destroyed".
 *   2. **A quiet network.** A document request that was in flight is drained before
 *      anything is asserted. Unlike a sleep, any activity restarts the quiet window, so
 *      this gets *more* patient as the machine gets busier rather than less.
 *
 * `scripted: false` for a context with JavaScript disabled, where there is no frame loop to
 * run and the network is the only observable left.
 */
export async function settleInteraction(
  page: Page,
  what: string,
  options: SettleOptions & { scripted?: boolean } = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULTS.timeout;
  if (options.scripted !== false) {
    await settle(page, { kind: 'frames' }, what, { minFrames: 12, ...options }).catch(
      () => undefined,
    );
  }
  await awaiting(`${what} (the network to go quiet)`, () =>
    page.waitForLoadState('networkidle', { timeout }),
  );
}

/**
 * Run `work`, and if it fails say what was being waited for.
 *
 * MUSE-54 AC3. A Playwright timeout names a selector or nothing at all, and a bare
 * timeout is the failure most likely to be re-run rather than read — which is the whole
 * cost of a flaky suite: not the re-run, but that the next genuine failure gets one too.
 */
export async function awaiting<T>(what: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    throw new Error(`gave up waiting for ${what}`, { cause });
  }
}
