/**
 * Build-time configuration this site reads off `import.meta.env`.
 *
 * Declared rather than inferred so `astro check` catches a typo in the variable name,
 * which is otherwise a silent `undefined` and a form that cannot deliver.
 */
interface ImportMetaEnv {
  /**
   * Where the trial-class form POSTs — `https://submit-form.com/<form-id>` (Formspark).
   *
   * The form id travels inside every page a visitor downloads, so it is configuration
   * rather than a secret and `PUBLIC_` is the correct prefix. Unset, the form still
   * renders and still validates; submitting reports that it could not be delivered
   * and offers the studio inbox instead.
   */
  readonly PUBLIC_FORM_ENDPOINT?: string;
}
