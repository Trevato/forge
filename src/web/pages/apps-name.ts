/**
 * The name a sentence suggests, for the New app form: server-side (the
 * boundary that counts) and, in `appNameJs`, the same rule in the browser
 * so the field shows a live preview before anyone submits anything.
 */

import { SLUG_MAX } from "../../core/apps.ts";

const MAX_WORDS = 6;

/**
 * A lowercase, hyphenated slug of the sentence's first few words — the same
 * shape a hostname label takes (`core/apps.ts`'s `SLUG_MAX`). Undefined
 * when nothing survives: punctuation only, or a script this ASCII slug
 * cannot carry.
 */
export function deriveAppName(sentence: string): string | undefined {
  const words = sentence.trim().split(/\s+/).slice(0, MAX_WORDS).join(" ");
  const slug = words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug === "" ? undefined : slug;
}

/**
 * Mirrors `deriveAppName` in the browser, live, as the sentence is typed —
 * a preview only. The name actually used is derived again on the server
 * (`deriveAppName`), which never trusts what this put in the field: the
 * script blanks it on submit unless the person edited it themselves.
 */
export const appNameJs = /* js */ `
(function () {
  var desc = document.getElementById('f-description');
  var name = document.getElementById('f-name');
  var form = name ? name.closest('form') : null;
  if (!desc || !name || !form) return;
  var touched = name.value.trim() !== '';
  name.addEventListener('input', function () { touched = true; });
  function slugify(s) {
    var words = s.trim().split(/\\s+/).slice(0, ${MAX_WORDS}).join(' ');
    return words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, ${SLUG_MAX})
      .replace(/-+$/g, '');
  }
  function preview() {
    if (touched) return;
    name.value = slugify(desc.value);
  }
  desc.addEventListener('input', preview);
  form.addEventListener('submit', function () {
    if (!touched) name.value = '';
  });
  preview();
})();
`;
