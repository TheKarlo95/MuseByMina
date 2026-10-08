import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * **The committed seed, read as documents — and the weekly timetable joined out of it.**
 *
 * `content/seed.ndjson` is both the migration artefact `npm run sanity:seed`
 * imports into the live dataset *and* the fixture every build in this suite reads
 * (`vitest.config.ts` points `MUSE_CONTENT_FIXTURE` at it). So "what the page renders"
 * and "what the studio publishes" are two views of one file, and a test may compare them
 * without a second copy of the content existing anywhere.
 *
 * That is what MUSE-36 needs. The old `/schedule` suite imported `src/data/schedule.ts`
 * — thirteen invented rows — and asserted the page rendered them faithfully, which it
 * did: the suite was green the whole time the site was publishing classes that do not
 * exist. Faithful rendering of fiction is not a passing test, so the oracle moved to the
 * seed, and the seed is checked against the timetable Mina supplied.
 *
 * The join below is deliberately *not* `SCHEDULE_QUERY`. Evaluating the real GROQ here
 * would make the assertion "the query agrees with itself"; `test/projections.test.ts`
 * is where the query is the thing under test. This walks the references by hand, so a
 * broken projection shows up as a disagreement between two independent readings.
 */

const SEED = fileURLToPath(new URL('../../content/seed.ndjson', import.meta.url));

export interface SeedDoc {
  _id: string;
  _type: string;
  [field: string]: unknown;
}

/** Every document in the seed, in file order. Drafts included — there are none. */
export function seedDocs(): SeedDoc[] {
  return readFileSync(SEED, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SeedDoc);
}

export function seedDocsOfType(type: string): SeedDoc[] {
  return seedDocs().filter((doc) => doc._type === type);
}

function docById(id: string): SeedDoc {
  const found = seedDocs().find((doc) => doc._id === id);
  if (!found) throw new Error(`The seed has no document \`${id}\`.`);
  return found;
}

function ref(value: unknown): string {
  const id = (value as { _ref?: unknown } | null)?._ref;
  if (typeof id !== 'string') throw new Error(`Not a reference: ${JSON.stringify(value)}`);
  return id;
}

function refs(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`Not an array of references: ${JSON.stringify(value)}`);
  return value.map(ref);
}

/** One class as the schedule renders it: when it runs, what it is, and who teaches it. */
export interface SeedRow {
  slotId: string;
  day: string;
  start: string;
  durationMin: number;
  level: string;
  name: { hr: string; en: string };
  /** Display names, in the order they are authored on the class. */
  instructors: string[];
}

/**
 * The weekly timetable the seed publishes, joined slot → class → instructors.
 *
 * Inactive slots are dropped, as `SCHEDULE_QUERY` drops them: a slot switched off for a
 * summer pause is content that exists and a class that does not run.
 */
export function seededSchedule(): SeedRow[] {
  return seedDocsOfType('scheduleSlot')
    .filter((slot) => slot.active !== false)
    .map((slot) => {
      const danceClass = docById(ref(slot.class));
      const teachers = slot.instructors === undefined
        ? refs(danceClass.instructors)
        : refs(slot.instructors);
      return {
        slotId: slot._id,
        day: slot.day as string,
        start: slot.start as string,
        durationMin: danceClass.durationMin as number,
        level: danceClass.level as string,
        name: danceClass.name as { hr: string; en: string },
        instructors: teachers.map((id) => docById(id).name as string),
      };
    })
    .sort((a, b) => `${a.day}|${a.start}`.localeCompare(`${b.day}|${b.start}`));
}
