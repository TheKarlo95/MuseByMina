import type { ClassEntry } from '../lib/schedule';

/* ============================================================================
   PLACEHOLDER CONTENT — the only file the Sanity ticket has to replace.
   ============================================================================

   These rows are invented. Days, times, instructors and the mix of styles are
   plausible for an adult bachata studio running evening classes, but none of it
   has been confirmed with Mina.

   This file exists so that swapping the data source is a *prop change*, not a
   rewrite. `Schedule.astro` takes its rows as a prop and only defaults to this
   export; the page wrappers pass nothing. When Sanity lands:

     -   <Schedule locale="hr" />
     +   <Schedule locale="hr" entries={await getSchedule()} />

   …and this file is deleted. Nothing else moves: the types, the locale wording
   for days / levels / styles / prerequisites, the pluralised counts and both
   layouts all live in `src/lib/schedule.ts` and the component.

   Shape contract for whatever replaces it (enforced by `ClassEntry`):
     day         one of mon…sun
     start       24-hour "HH:MM" — `formatTime` throws on anything else
     durationMin minutes
     style       traditional | moderna | sensual
     level       beginner | intermediate | advanced    (Početni/Srednji/Napredni)
     instructor  display name, as typed

   One deliberate property of this set: there is no advanced traditional class.
   The empty state has to be reachable, so at least one level+style pair must
   match nothing — `test/schedule.test.ts` asserts that rather than trusting it.
   ============================================================================ */

export const SCHEDULE: ClassEntry[] = [
  // Monday — the traditional track, which is where absolute beginners start.
  { day: 'mon', start: '19:00', durationMin: 60, style: 'traditional', level: 'beginner', instructor: 'Mina' },
  { day: 'mon', start: '20:00', durationMin: 60, style: 'traditional', level: 'intermediate', instructor: 'Mina' },

  // Tuesday
  { day: 'tue', start: '19:00', durationMin: 60, style: 'moderna', level: 'beginner', instructor: 'Luka' },
  { day: 'tue', start: '20:00', durationMin: 60, style: 'sensual', level: 'intermediate', instructor: 'Petra' },
  { day: 'tue', start: '21:00', durationMin: 60, style: 'moderna', level: 'advanced', instructor: 'Luka' },

  // Wednesday
  { day: 'wed', start: '19:00', durationMin: 60, style: 'sensual', level: 'beginner', instructor: 'Mina' },
  { day: 'wed', start: '20:00', durationMin: 60, style: 'moderna', level: 'intermediate', instructor: 'Luka' },

  // Thursday
  { day: 'thu', start: '19:00', durationMin: 60, style: 'traditional', level: 'beginner', instructor: 'Mina' },
  { day: 'thu', start: '20:00', durationMin: 60, style: 'sensual', level: 'advanced', instructor: 'Petra' },
  { day: 'thu', start: '21:00', durationMin: 60, style: 'sensual', level: 'intermediate', instructor: 'Mina' },

  // Saturday — daytime, which is why the grid derives its rows from the data
  // rather than assuming an evening-only timetable.
  { day: 'sat', start: '11:00', durationMin: 60, style: 'moderna', level: 'beginner', instructor: 'Luka' },
  { day: 'sat', start: '12:00', durationMin: 60, style: 'traditional', level: 'intermediate', instructor: 'Mina' },
  { day: 'sat', start: '13:00', durationMin: 60, style: 'sensual', level: 'advanced', instructor: 'Petra' },
];
