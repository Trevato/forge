/**
 * The name a sentence suggests, for the New app form: server-side (the
 * boundary that counts) and, in `appNameJs`, the same rule in the browser
 * so the field shows a live preview before anyone submits anything.
 */

import { SLUG_MAX } from "../../core/apps.ts";

/** Words considered from the front of the sentence, before filtering. */
const MAX_WORDS = 6;

/** Meaningful words kept in the name, after the small words are dropped. */
const MAX_NAME_WORDS = 2;

/**
 * Leading articles and the small connecting words nobody would name an app
 * after: dropped from the window before the name is built. Lowercase,
 * ASCII, no punctuation — matched against a word with its own punctuation
 * stripped, so "words," and "words" are the same lookup.
 */
export const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "about",
  "into",
  "onto",
  "from",
  "over",
  "under",
  "between",
  "and",
  "or",
  "but",
  "nor",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "its",
  "this",
  "that",
  "these",
  "those",
  "it",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "shall",
  "may",
  "might",
  "must",
  "as",
  "so",
  "than",
  "then",
  "not",
  "no",
]);

/**
 * The first few meaningful words of the sentence: the stop words dropped
 * from a window at its front, capped to a couple of words. A sentence that
 * is only stop words falls back to the window verbatim, so the name is
 * never built from nothing.
 */
function contentWords(sentence: string): string[] {
  const front = sentence.trim().split(/\s+/).slice(0, MAX_WORDS);
  const meaningful = front.filter(
    (word) => !STOP_WORDS.has(word.toLowerCase().replace(/[^a-z0-9]/g, "")),
  );
  return (meaningful.length > 0 ? meaningful : front).slice(0, MAX_NAME_WORDS);
}

/**
 * A lowercase, hyphenated slug of the sentence's first couple of meaningful
 * words — the same shape a hostname label takes (`core/apps.ts`'s
 * `SLUG_MAX`). Undefined when nothing survives: punctuation only, or a
 * script this ASCII slug cannot carry.
 */
export function deriveAppName(sentence: string): string | undefined {
  const words = contentWords(sentence).join(" ");
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
 *
 * Generated from `deriveAppName`'s own constants (`MAX_WORDS`,
 * `MAX_NAME_WORDS`, `STOP_WORDS`) so the two never drift apart.
 */
export const appNameJs = /* js */ `
(function () {
  var desc = document.getElementById('f-description');
  var name = document.getElementById('f-name');
  var form = name ? name.closest('form') : null;
  if (!desc || !name || !form) return;
  var touched = name.value.trim() !== '';
  name.addEventListener('input', function () { touched = true; });
  var stopWords = ${JSON.stringify(Array.from(STOP_WORDS))};
  function contentWords(s) {
    var front = s.trim().split(/\\s+/).slice(0, ${MAX_WORDS});
    var meaningful = front.filter(function (word) {
      return stopWords.indexOf(word.toLowerCase().replace(/[^a-z0-9]/g, '')) === -1;
    });
    return (meaningful.length > 0 ? meaningful : front).slice(0, ${MAX_NAME_WORDS});
  }
  function slugify(s) {
    var words = contentWords(s).join(' ');
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
