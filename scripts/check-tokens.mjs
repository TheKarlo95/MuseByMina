import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * Design-system compliance.
 *
 * Rules the spec states once and every component then has to remember. Both of
 * the ones below fail *silently* — the CSS is valid, the page renders, and the
 * damage is only visible in the other theme or at 4x zoom. So they are checked
 * rather than written down.
 *
 * 1. COLOUR — "Components never reference a brand colour. They reference a
 *    role." Gold on cream is 2.02:1 and fails every threshold, so a literal that
 *    looks fine in dark will be unreadable in light. `--accent` simply IS gold in
 *    dark and gold-deep in light — use the role and it cannot go wrong.
 *
 *    Legitimate exception: the header and footer sit on --surface-deep, which is
 *    plum-ink in BOTH themes, so their contents are deliberately fixed brand
 *    colours rather than theme-following roles (§12).
 *
 * 2. NUMERALS — `font-variant-numeric` is set once for the whole document, in
 *    `src/styles/base.css` (MUSE-14). Cormorant's default figures are old-style,
 *    so `19:00` renders `I9:OO`; the document rule asks for `lining-nums
 *    tabular-nums` to fix it. The property is a single inherited value, so a
 *    component that writes `font-variant-numeric: tabular-nums` REPLACES the
 *    document's value instead of adding to it — the column still aligns, the
 *    computed style still looks deliberate, and the times are unreadable again.
 *    That is exactly how MUSE-14 shipped. Numerals are a typography-layer
 *    decision; a component should never have an opinion about them.
 *
 * Either rule can be opted out of on a line marked `ds-allow`.
 */
const SCAN = ['src/components', 'src/layouts', 'src/pages'];

const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/;
const BRAND_VAR = /var\(\s*--(plum|gold|cream|red|green)[a-z-]*\s*[,)]/;
const NUMERALS = /font-variant-numeric\s*:|font-feature-settings\s*:/;
const ALLOW = /ds-allow/;

const files = SCAN.flatMap((dir) =>
  globSync(`${dir}/**/*.{astro,ts,css}`, { cwd: process.cwd() }),
);

let problems = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');

  // Track the current CSS comment block so a `ds-allow` note covers the rule below it.
  let allowBlock = false;
  // Track /* ... */ spans so a hex quoted mid-comment is not read as a declaration.
  let inComment = false;

  lines.forEach((line, i) => {
    if (ALLOW.test(line)) {
      allowBlock = true;
      return;
    }
    // A blank line ends an allow block, keeping the opt-out tightly scoped.
    if (line.trim() === '') allowBlock = false;

    // A hex quoted inside a comment is documentation, not a style declaration.
    const trimmed = line.trim();
    const opens = line.includes('/*') && !line.includes('*/');
    const closes = inComment && line.includes('*/');
    const wasInComment = inComment;
    if (opens) inComment = true;
    if (closes) inComment = false;

    const isComment =
      wasInComment ||
      opens ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('<!--');
    if (isComment) return;

    const hex = HEX.test(line);
    const brand = BRAND_VAR.test(line);
    const numerals = NUMERALS.test(line);
    if (!hex && !brand && !numerals) return;
    if (allowBlock) return;

    problems += 1;

    if (numerals) {
      console.log(`✗ ${file}:${i + 1}  numerals set in a component`);
      console.log(`    ${line.trim()}`);
      console.log(
        `    → font-variant-numeric is one inherited value, set for the whole`,
      );
      console.log(
        `      document in src/styles/base.css. Declaring it here REPLACES`,
      );
      console.log(
        `      "lining-nums tabular-nums" and brings back "19:00" → "I9:OO" (MUSE-14).`,
      );
      console.log(`      Change the document rule, or mark the line "ds-allow".`);
      return;
    }

    const what = hex ? 'hard-coded hex' : 'brand colour variable';
    console.log(`✗ ${file}:${i + 1}  ${what}`);
    console.log(`    ${line.trim()}`);
    console.log(
      `    → use a role token (--surface, --text, --accent, --accent-fill, --line),`,
    );
    console.log(`      or mark the line with "ds-allow" if this band is theme-fixed.`);
  });
}

if (problems) {
  console.log(`\n${problems} design-system violation(s).`);
  process.exit(1);
}
console.log(`Design system: ${files.length} files clean.`);
