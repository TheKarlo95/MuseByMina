import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  baseRevision,
  releaseVerdict,
  report,
  sequence,
} from '../scripts/sanity-seed-release.mjs';
import { parseSeed, readSeed } from '../scripts/seed-compare.mjs';
import { frag } from './helpers/source-guard';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/**
 * MUSE-78 — **a seed edit that reaches nobody, and the direction that tells the two
 * drift cases apart.**
 *
 * The defect was an absence of signal, not a wrong answer. The build fetches the live
 * dataset and the suite reads `content/seed.ndjson`, so a branch that *edits* a seeded
 * document is green in CI, green in the suite, correct in the diff — and changes nothing
 * on the live site until somebody imports. MUSE-71 shipped exactly that way: the fix for
 * a false commercial promise landed in five code surfaces and stayed absent from both
 * `<meta name="description">` tags for fourteen minutes, with everything green.
 *
 * `npm run sanity:seed:check` already compares the seed with the dataset and would have
 * said `DRIFTED`. It is `continue-on-error` in CI and that decision is right (MUSE-45): a
 * Studio edit must never fail a deploy. The flaw is that `DRIFTED` is one word for two
 * opposite situations — **the dataset ahead**, which is Mina editing and is nobody's
 * blocker, and **the seed ahead**, which is our own unshipped change and is. This file is
 * the proof that the gate can tell them apart, stated as the table in the script's header
 * and exercised row by row.
 *
 * It performs no build, no dev server and no browser launch, which is not an accident:
 * MUSE-68's heavyweight budget is at 80 of 80 with zero headroom, so the whole decision
 * is a pure function of three arguments — a base seed, a head seed and a dataset — and
 * the `git` and `fetch` halves are the thin shell around it.
 */

/* ------------------------------------------------------------------ fixtures */

type Doc = Record<string, unknown> & { _id: string; _type: string };

/** A `page` document in the shape the seed holds one, with one field worth editing. */
const page = (id: string, hr: string, en = 'A dance studio in Zagreb.'): Doc => ({
  _id: id,
  _type: 'page',
  route: id === 'page-home' ? '/' : `/${id.replace('page-', '')}`,
  title: { _type: 'localeString', hr: 'Muse by Mina', en: 'Muse by Mina' },
  description: { _type: 'localeString', hr, en },
});

const settings = (tagline: string): Doc => ({
  _id: 'siteSettings',
  _type: 'siteSettings',
  studioName: 'Muse by Mina',
  address: 'Ilica 209, Zagreb',
  tagline: { _type: 'localeString', hr: tagline, en: 'Bachata for adults.' },
});

/** The claim MUSE-71 withdrew, and the text it withdrew it to. */
const PROMISED = 'Dođi na besplatni probni sat.';
const WITHDRAWN = 'Dođi na probni sat.';
/** A third value, as if typed in the Studio. */
const MINAS = 'Dođi na prvi sat.';

const lines = (verdict: ReturnType<typeof releaseVerdict>, merged = false): string =>
  report(verdict, { merged }).join('\n');

/* ------------------------------------------------------------------ 1. direction */

describe('whose change is it — the direction that is the whole ticket', () => {
  /**
   * AC2, and the property MUSE-45 and the `continue-on-error` decision both protect.
   *
   * The dataset here is as far from the seed as it can be, on the only field that
   * matters, and the branch has no opinion about it. Nothing fires. This is the assertion
   * that makes the gate safe to *block* on at all: if a branch that touches nothing could
   * go red, the gate would be `sanity:seed:check` with teeth, and Mina rewording a title
   * would fail every open pull request.
   */
  it('a branch that does not touch the seed never blocks, however far the dataset has drifted', () => {
    const seed = [settings('Plesni studio u Zagrebu.'), page('page-home', WITHDRAWN)];
    const verdict = releaseVerdict({
      base: seed,
      head: seed,
      live: [settings('Nešto posve drugo.'), page('page-home', MINAS)],
    });

    expect(verdict.blocked).toBe(false);
    expect(verdict.authored).toEqual([]);
    expect(verdict.pending).toEqual([]);
    // Reported, because a stale fixture is worth knowing about — and explicitly not
    // anybody's problem to fix before merging.
    expect(verdict.collateral.map(({ id }) => id)).toEqual(['siteSettings', 'page-home']);
    expect(lines(verdict)).toContain('does not change content/seed.ndjson');
    expect(lines(verdict)).toContain('Mina editing in the Studio');
    expect(lines(verdict)).toContain('no pull request fails');
  });

  /**
   * AC1, and the teeth. This is MUSE-71's branch, one commit before the import.
   *
   * The failure has to name the `_id` and the field path, because "the seed drifted" is
   * what the existing check already said and what nobody acted on. `description.hr` is
   * the field that reaches Google.
   */
  it('a seed edit the dataset does not hold is named, by _id and field, and blocks', () => {
    const verdict = releaseVerdict({
      base: [page('page-home', PROMISED)],
      head: [page('page-home', WITHDRAWN)],
      live: [page('page-home', PROMISED)],
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.authored).toEqual(['page-home']);
    expect(verdict.pending).toHaveLength(1);
    expect(verdict.pending[0].id).toBe('page-home');
    expect(verdict.pending[0].fields.map((f) => f.path)).toEqual(['description.hr']);
    // `stale`, not `conflict`: the dataset still holds the pre-branch value, so nobody
    // else has touched it and an import is unambiguously the right move.
    expect(verdict.pending[0].fields[0].kind).toBe('stale');
    expect(verdict.conflicts).toEqual([]);

    const message = lines(verdict);
    expect(message).toContain('page-home (page)');
    expect(message).toContain('description.hr');
    expect(message).toContain(WITHDRAWN);
    expect(message).toContain(PROMISED);
  });

  /**
   * The same branch after the import — the state sequence 1 produces, and the reason the
   * gate steers toward it rather than merely complaining. Running `npm run sanity:seed`
   * is what makes this check green, so the remedy and the gate are the same action.
   */
  it('the same edit, once imported, passes and says the merge will publish it', () => {
    const verdict = releaseVerdict({
      base: [page('page-home', PROMISED)],
      head: [page('page-home', WITHDRAWN)],
      live: [page('page-home', WITHDRAWN)],
    });

    expect(verdict.blocked).toBe(false);
    expect(verdict.authored).toEqual(['page-home']);
    expect(verdict.pending).toEqual([]);
    expect(verdict.imported).toEqual([
      { id: 'page-home', type: 'page', fields: ['description.hr'] },
    ]);
    expect(lines(verdict)).toContain('already in the dataset');
    expect(lines(verdict)).toContain('a build is the only thing that reads');
  });

  /**
   * The *adding* case — the one the ticket calls safe by accident.
   *
   * It is folded into the same gate rather than left to the build, so that one message
   * carries the whole sequence. The build failing is what stops it reaching a visitor; it
   * is not what tells you that importing before the merge is cheaper than after.
   */
  it('a document the branch adds is pending too, and says why that case cannot ship silently', () => {
    const verdict = releaseVerdict({
      base: [],
      head: [page('page-whatisbachata', 'Što je bachata?')],
      live: [],
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.pending[0]).toMatchObject({ id: 'page-whatisbachata', absent: true });
    const message = lines(verdict);
    expect(message).toContain('the dataset has no such document');
    expect(message).toContain('build refuses to publish past');
  });

  /**
   * An import never deletes, which is a property of `sanity dataset import --replace`
   * and not of this check. Dropping a document from the seed therefore leaves it live and
   * leaves the site reading it — worth one line, and not a reason to fail: the document
   * may be one somebody is about to remove in the Studio.
   */
  it('a document dropped from the seed is reported, not blocked — an import never deletes', () => {
    const verdict = releaseVerdict({
      base: [page('page-home', WITHDRAWN), page('page-old', 'Stara stranica')],
      head: [page('page-home', WITHDRAWN)],
      live: [page('page-home', WITHDRAWN), page('page-old', 'Stara stranica')],
    });

    expect(verdict.blocked).toBe(false);
    expect(verdict.removed).toEqual([{ id: 'page-old', type: 'page' }]);
    expect(lines(verdict)).toContain('An import');
    expect(lines(verdict)).toContain('never deletes');
    expect(lines(verdict)).toContain('Delete them in the Studio');
  });
});

/* ------------------------------------------------------------------ 2. both at once */

describe('when both have moved, the message says so rather than picking one', () => {
  /**
   * The case a naive diff reads backwards, and the one the ticket asks to be explicit
   * about: three values on one field. The seed is ahead of the base *and* the dataset is
   * ahead of the base, differently.
   *
   * Importing reverts the Studio edit; merging without importing drops ours. Neither is
   * a default this check is entitled to choose, so it prints all three and asks for the
   * decision to be written into the seed — the only place an import can read it from.
   */
  it('names all three values on a field both sides rewrote, and refuses to choose', () => {
    const verdict = releaseVerdict({
      base: [page('page-home', PROMISED)],
      head: [page('page-home', WITHDRAWN)],
      live: [page('page-home', MINAS)],
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.pending[0].fields[0].kind).toBe('conflict');
    expect(verdict.conflicts).toHaveLength(1);
    expect(verdict.conflicts[0].id).toBe('page-home');
    expect(verdict.conflicts[0].field.path).toBe('description.hr');

    const message = lines(verdict);
    expect(message).toContain('BOTH HAVE MOVED');
    expect(message).toContain('will not choose');
    expect(message).toContain('page-home.description.hr');
    for (const value of [PROMISED, WITHDRAWN, MINAS]) {
      expect(message, `all three values must be printed: ${value}`).toContain(value);
    }
  });

  /**
   * The quieter half of "both moved": different fields, so no single field is in
   * conflict and a field-by-field reading would report nothing unusual.
   *
   * It matters because `npm run sanity:seed` is `--replace` over the **whole file**. The
   * import that ships our `description.hr` also writes `siteSettings.tagline` back to
   * whatever the seed happens to hold, reverting a Studio edit nobody was asked about.
   * So collateral is reported *with* the blocker — the fix for it has to happen before
   * the import the blocker is asking for.
   */
  it('warns that the import also reverts fields the branch did not write', () => {
    const verdict = releaseVerdict({
      base: [settings('Plesni studio u Zagrebu.'), page('page-home', PROMISED)],
      head: [settings('Plesni studio u Zagrebu.'), page('page-home', WITHDRAWN)],
      live: [settings('Bachata u Zagrebu, za odrasle.'), page('page-home', PROMISED)],
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.conflicts).toEqual([]);
    expect(verdict.collateral).toHaveLength(1);
    expect(verdict.collateral[0].id).toBe('siteSettings');
    expect(verdict.collateral[0].fields.map(({ path }) => path)).toEqual(['tagline.hr']);

    const message = lines(verdict);
    expect(message).toContain('WOULD ALSO REVERT');
    expect(message).toContain('over every document in the');
    expect(message).toContain('Bachata u Zagrebu, za odrasle.');
  });

  /**
   * And the same thing across documents rather than within one, which is the likelier
   * shape: we rewrite a page description, Mina rewrites a different page's.
   */
  it('separates the blocker from the drift when they are in different documents', () => {
    const verdict = releaseVerdict({
      base: [page('page-home', PROMISED), page('page-pricing', 'Cjenik')],
      head: [page('page-home', WITHDRAWN), page('page-pricing', 'Cjenik')],
      live: [page('page-home', PROMISED), page('page-pricing', 'Cjenik i uvjeti')],
    });

    expect(verdict.blocked).toBe(true);
    expect(verdict.pending.map(({ id }) => id)).toEqual(['page-home']);
    expect(verdict.collateral.map(({ id }) => id)).toEqual(['page-pricing']);
  });
});

/* ------------------------------------------------------------------ 3. the sequence */

describe('the message is an order of operations, not a reminder to seed', () => {
  /**
   * The ticket's comment is the specification for this, and it is the one assertion that
   * cannot be derived from the code: *"'Run `npm run sanity:seed`' is insufficient
   * guidance — it is what I did, and the site stayed wrong."*
   *
   * So before the merge the message has to say **import first**, and it has to say why
   * importing afterwards is not the same thing: the push deploy has already fetched the
   * dataset, and the next build is scheduled.
   */
  it('before the merge: one step, with the reason the other order fails', () => {
    const before = sequence({ merged: false }).join('\n');

    expect(before).toContain('import first, then merge');
    expect(before).toContain('npm run sanity:seed');
    expect(before).toContain('after* the merge is not enough');
    expect(before).toContain('MAX_WAIT_HOURS');
    expect(before).toContain('src/lib/rebuild.ts');
    // The safety of sequence 1, which is the only thing that could make somebody hesitate
    // to import content whose pull request has not landed.
    expect(before).toContain('keyed on _id');
  });

  /**
   * After the merge there are **two** steps, and the message leads with the second being
   * the forgettable one — because the first succeeds, and a successful import looks like
   * the end of the job. That is precisely the 08:41/08:43 gap in the ticket's timeline.
   */
  it('after the merge: two steps, and the forced rebuild is not optional', () => {
    const after = sequence({ merged: true }).join('\n');

    expect(after).toContain('already on `main`');
    expect(after).toContain('npm run sanity:seed');
    expect(after).toContain('Run workflow');
    expect(after).toContain('not optional');
    expect(after).toContain('import before');
    // The two orders must not read the same, or there was no point deriving one.
    expect(after).not.toBe(sequence({ merged: false }).join('\n'));
  });

  it('prints the sequence whenever something is pending, and not otherwise', () => {
    const pending = releaseVerdict({
      base: [page('page-home', PROMISED)],
      head: [page('page-home', WITHDRAWN)],
      live: [page('page-home', PROMISED)],
    });
    const clear = releaseVerdict({
      base: [page('page-home', PROMISED)],
      head: [page('page-home', WITHDRAWN)],
      live: [page('page-home', WITHDRAWN)],
    });

    expect(lines(pending)).toContain('THE SEQUENCE');
    expect(lines(pending, true)).toContain('THE SEQUENCE');
    expect(lines(clear)).not.toContain('THE SEQUENCE');
  });
});

/* ------------------------------------------------------------------ 4. fails open */

describe('what it does when it cannot tell', () => {
  /**
   * An unreachable dataset passes, and says so. `ci.yml`'s `rebuildloop` job set that
   * precedent — "we could not tell" must not block a pull request — and here it costs
   * nothing: since MUSE-20 `npm run build` fetches the dataset in three separate jobs and
   * hard-fails on an outage, so an unreachable API is already red everywhere that
   * matters. A second red for one outage only teaches people to ignore this one.
   */
  it('an unreadable dataset does not block, and names what is unknown', () => {
    const verdict = releaseVerdict({
      base: [page('page-home', PROMISED)],
      head: [page('page-home', WITHDRAWN)],
      live: null,
    });

    expect(verdict.blocked).toBe(false);
    expect(verdict.unreadable).toBe(true);
    // The git half still works without the network, so the branch's claim is still named.
    expect(verdict.authored).toEqual(['page-home']);
    const message = lines(verdict);
    expect(message).toContain('could not be read');
    expect(message).toContain('page-home');
    expect(message).toContain('Not failing on it');
  });

  /**
   * GitHub's `github.event.before` is forty zeros on a force-push or a new branch. That
   * must resolve to "no base", not fall through to the merge base — on a push to `main`
   * the merge base is HEAD itself, which would make base equal head and report that a
   * commit nobody compared with anything changes nothing.
   *
   * Asserted through the pure half of `baseRevision`, which returns before it reaches
   * `git`: nothing under `test/` may start a child process (MUSE-34, rule 5).
   */
  it('treats GitHub’s all-zero sha as "no base", not as the merge base', () => {
    expect(baseRevision({ SEED_BASE_SHA: '0'.repeat(40) })).toBeNull();
  });
});

/* ------------------------------------------------------------------ 5. wiring */

describe('where it runs', () => {
  it('is an npm script', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['sanity:seed:release']).toBe('node scripts/sanity-seed-release.mjs');
  });

  /**
   * In the `sanity` job, which already holds the project and dataset variables and needs
   * neither a build nor a browser — so hosting it there costs a GROQ `GET` and a
   * `git show`, the same trade MUSE-58's format check made in `designsystem`.
   *
   * Comments are stripped before the assertions, for the reason this repository has
   * written down four times: a guard that reads prose fails on the paragraph explaining
   * it, and the cheapest way to make that failure go away is to delete the explanation.
   */
  it('is a step in the sanity job, and the base sha and the merge state reach it', () => {
    const ci = read('.github/workflows/ci.yml');
    const from = ci.indexOf('\n  sanity:');
    expect(from, 'the sanity job must still exist to host the step').toBeGreaterThan(0);
    const to = ci.indexOf('\n  designsystem:');
    const job = ci
      .slice(from, to === -1 ? undefined : to)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(job).toContain('npm run sanity:seed:release');
    expect(job).toContain('SEED_BASE_SHA:');
    expect(job).toContain('SEED_MERGED:');
    // The merge base has to be *in* the checkout for `git show` to read it, and
    // `actions/checkout` fetches one commit by default. Without this the gate would
    // report "could not be determined" on every run and pass — the exact shape of
    // silent-pass this ticket exists to remove.
    expect(job).toContain('fetch-depth: 0');
  });

  /**
   * **The constraint that must survive.** `sanity:seed:check` stays non-blocking.
   *
   * MUSE-45's property and the `continue-on-error` decision are the same property: a
   * Studio edit must never fail a deploy, because changing copy without one is the whole
   * point of the CMS. This ticket adds a gate *beside* that step; it does not make drift
   * fatal, and the two are kept distinguishable here so that a later tidy-up cannot
   * collapse them into one blocking check.
   */
  it('leaves sanity:seed:check non-blocking, and does not take its continue-on-error', () => {
    const ci = read('.github/workflows/ci.yml');

    const steps = ci.split(/^      - name: /m).slice(1);
    const named = (fragment: string): string => {
      const found = steps.filter((step) => step.includes(fragment));
      expect(found, `exactly one step runs ${fragment}`).toHaveLength(1);
      return found[0];
    };

    expect(named('npm run sanity:seed:check')).toContain('continue-on-error: true');
    expect(named('npm run sanity:seed:release')).not.toContain('continue-on-error');
  });

  /**
   * Option 3 on the ticket, rejected and asserted as rejected: auto-seeding on merge
   * needs a content-write credential in CI, and this project's architecture was
   * deliberately arranged so none exists (MUSE-21 declined a GitHub token inside Sanity;
   * MUSE-45 kept content edits away from `SANITY_DEPLOY_TOKEN`).
   *
   * So the gate is read-only by construction and this is what says so. Stated against
   * what the files *do*, not against words in them: both scripts tell you to run
   * `sanity dataset import` in their prose, and a scan for that phrase would fail on the
   * instruction while passing a real invocation beside it. That is this repository's
   * recurring guard defect (MUSE-34, MUSE-76) and it is not worth committing inside the
   * guard for a credential rule.
   *
   * Three claims instead, each about something the code does. The only Sanity endpoint
   * either file builds a URL for is `data/query` — `data/mutate` is the write one. The
   * only program the gate spawns is `git`, which is where an import would have to be
   * invoked from, since Sanity's import tool is the CLI. And the environment both files
   * read is **exactly** five names: a token could only arrive as a sixth.
   *
   * `test/sanity.test.ts` makes the repository-wide claim about read tokens; this is the
   * one about the two files this ticket added.
   */
  it('is read-only — the gate can report an import, never perform one', () => {
    const files = ['scripts/sanity-seed-release.mjs', 'scripts/seed-compare.mjs'];
    const environment = new Set<string>();

    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toContain('data/mutate');

      // `frag` for the reason it exists: this file is inside the tree
      // `copyPasteTripwire` searches, and a literal needle here is the needle in the
      // source. Same convention as `test/helpers/source-guard.ts`'s own list.
      const starter = new RegExp(`${frag('exec', 'FileSync')}\\(\\s*'([^']+)'`, 'g');
      for (const [, program] of source.matchAll(starter)) {
        expect(program, `${file} may run git and nothing else`).toBe('git');
      }

      // `process.env.X` and the injected `env.X` alike. Prose names the rejected tokens
      // without the prefix, so the paragraph above cannot trip this.
      for (const [, name] of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
        environment.add(name);
      }
    }

    expect([...environment].sort(), 'a credential could only arrive as a sixth name').toEqual([
      'SANITY_API_VERSION',
      'SANITY_DATASET',
      'SANITY_PROJECT_ID',
      'SEED_BASE_SHA',
      'SEED_MERGED',
    ]);

    // And the query endpoint is still the one being read, so the rule above is about a
    // URL this code builds rather than one it has stopped building.
    expect(read('scripts/seed-compare.mjs')).toContain('data/query');
  });
});

/* ------------------------------------------------------------------ 6. the real seed */

describe('against the seed that is actually committed', () => {
  /**
   * The comparison is only as good as its idea of "unchanged". Every leaf of all
   * twenty-odd real documents, against itself: if `contentOf` or `leaves` disagreed with
   * themselves about array keys, `_type` markers or a `null`, the gate would report a
   * branch that touched nothing — and the first person to see that would turn the gate
   * off rather than read it.
   */
  it('reads the committed seed and finds nothing authored when nothing changed', () => {
    const seed = parseSeed(readSeed());
    expect(seed.length).toBeGreaterThan(10);

    const verdict = releaseVerdict({ base: seed, head: seed, live: seed });
    expect(verdict.authored).toEqual([]);
    expect(verdict.pending).toEqual([]);
    expect(verdict.collateral).toEqual([]);
    expect(verdict.removed).toEqual([]);
    expect(verdict.blocked).toBe(false);
  });

  /**
   * And the live instance, as the ticket's worked example rather than as a hypothetical:
   * one field of one real document, edited the way MUSE-71 edited it.
   */
  it('names the real document when one real field is edited', () => {
    const base = parseSeed(readSeed()) as Doc[];
    const head = parseSeed(readSeed()) as Doc[];
    const home = head.find((doc) => doc._id === 'page-home');
    expect(home, 'the seed must still hold page-home').toBeTruthy();
    (home as unknown as { description: { hr: string } }).description.hr = 'Nešto drugo.';

    const verdict = releaseVerdict({ base, head, live: base });
    expect(verdict.authored).toEqual(['page-home']);
    expect(verdict.pending).toHaveLength(1);
    expect(verdict.pending[0].fields.map((f) => f.path)).toEqual(['description.hr']);
    expect(verdict.collateral).toEqual([]);
  });
});
