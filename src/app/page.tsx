import { ThemeSwitch } from '@/components/ThemeSwitch';
import styles from './page.module.css';

/**
 * Foundation check — not a real page.
 *
 * Renders the design system's own test strings (§10) and the role tokens so
 * both themes can be verified before any real page is built. Replaced by the
 * homepage once the CMS is wired up.
 */
export default function FoundationCheck() {
  return (
    <>
      <a className="skip-link" href="#main">
        Preskoči na sadržaj
      </a>
      <main id="main" className={styles.page}>
        <div className={styles.header}>
          <p className={styles.eyebrow}>Plesni studio · Zagreb</p>
          <ThemeSwitch />
        </div>

        <h1 className={styles.display}>Tri stila. Jedan ritam.</h1>
        <p className={styles.lede}>
          Naši satovi traju 60 minuta i podijeljeni su u tri razine. Dođi na
          probni sat i osjeti glazbu.
        </p>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Dijakritički znakovi</h2>
          <div className={styles.diacritics}>
            <span>Čč</span>
            <span>Ćć</span>
            <span>Žž</span>
            <span>Šš</span>
            <span>Đđ</span>
          </div>
          <p className={styles.lede}>
            Đđ mora ostati čitljiv — <strong>Dođi</strong>, ne “Dodi”.
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Display 400 / 600</h2>
          <div className={styles.weights}>
            <span>Dođi na probni sat — 400</span>
            <span className={styles.weight600}>Dođi na probni sat — 600</span>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Razine</h2>
          <div className={styles.levels}>
            <span className={styles.pill}>Početni</span>
            <span className={`${styles.pill} ${styles.pillActive}`}>Srednji</span>
            <span className={styles.pill}>Napredni</span>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Površine</h2>
          <div className={styles.swatches}>
            <div className={`${styles.swatch} ${styles.surface}`}>surface</div>
            <div className={`${styles.swatch} ${styles.surfaceSunken}`}>sunken</div>
            <div className={`${styles.swatch} ${styles.surfaceRaised}`}>raised</div>
            <div className={`${styles.swatch} ${styles.surfaceDeep}`}>deep</div>
            <div className={`${styles.swatch} ${styles.accentFill}`}>accent-fill</div>
          </div>
        </section>
      </main>
    </>
  );
}
