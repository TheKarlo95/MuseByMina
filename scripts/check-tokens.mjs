import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * Design-system compliance.
 *
 * The spec's central rule: "Components never reference a brand colour. They
 * reference a role." Gold on cream is 2.02:1 and fails every threshold, so a
 * literal that looks fine in dark will be unreadable in light. `--accent` simply
 * IS gold in dark and gold-deep in light — use the role and it cannot go wrong.
 *
 * This makes that rule mechanical instead of aspirational.
 *
 * Legitimate exception: the header and footer sit on --surface-deep, which is
 * plum-ink in BOTH themes, so their contents are deliberately fixed brand colours
 * rather than theme-following roles (§12). Mark those lines with `ds-allow`.
 */
const SCAN = ['src/components', 'src/layouts', 'src/pages'];

const HEX = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/;
const BRAND_VAR = /var\(\s*--(plum|gold|cream|red|green)[a-z-]*\s*[,)]/;
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
    if (!hex && !brand) return;
    if (allowBlock) return;

    problems += 1;
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
