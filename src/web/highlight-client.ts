/**
 * The browser entry point for syntax highlighting — the *only* file in this
 * repository that is built for the client. `Bun.build` bundles it with
 * `highlight.ts`, `highlight-html.ts` and `html.ts` (all pure string work,
 * zero dependencies, nothing that reaches for a server API) into one ES
 * module served from `/assets/highlight-<hash>.js`.
 *
 * It publishes exactly one global, `window.forgeHighlight`, because the
 * editor's inline script — which the CSP admits by nonce — needs a handle on
 * it. Everything is exported too, so a test can import the built module and
 * prove the browser and the server render identical HTML. They must: the
 * editor paints highlighted text *underneath* a transparent textarea, and one
 * span's difference would put the caret in the wrong place.
 */

import {
  detectLanguage,
  INITIAL_SCAN,
  languageFromFirstLine,
  scanOneLine,
  type Language,
  type ScanState,
} from "./highlight.ts";
import {
  highlightToHtml,
  highlightToLines,
  renderTokens,
} from "./highlight-html.ts";

/** Text → HTML, newlines kept: the same string the server renders. */
export function render(text: string, lang: string): string {
  return highlightToHtml(text, asLanguage(lang));
}

/** Text → one HTML string per line, which is what the mirror is made of. */
export function renderLines(text: string, lang: string): string[] {
  return highlightToLines(text, asLanguage(lang));
}

/** A path (and optionally its first line) → the language to highlight it as. */
export function detect(path: string, firstLine?: string): Language {
  return detectLanguage(path, firstLine);
}

function asLanguage(lang: string): Language {
  return lang === "" ? "plain" : (lang as Language);
}

/** What changed, so the caller can touch only those nodes. */
export interface MirrorUpdate {
  /** Every line's HTML, in order. */
  html: string[];
  /** The first line whose HTML may have changed. */
  from: number;
  /** One past the last line whose HTML may have changed. */
  to: number;
  /** How the line count moved (positive = lines inserted at `from`). */
  delta: number;
}

/**
 * The editor's incremental highlighter.
 *
 * Re-tokenizing ten thousand lines on every keystroke is the difference
 * between an editor that feels instant and one that does not, so this keeps
 * the scanner state at the head of every line: an edit re-scans from the
 * first changed line and stops as soon as the state entering an unchanged
 * line matches what it was before — one line for ordinary typing, and only
 * ever the whole file when an unterminated block comment really does reach
 * the end of it.
 */
export class Mirror {
  private lines: string[] = [];
  private html: string[] = [];
  /** `states[i]` is the scanner state *entering* line `i`. */
  private states: ScanState[] = [INITIAL_SCAN];
  private readonly lang: Language;

  constructor(lang: string) {
    this.lang = asLanguage(lang);
  }

  update(text: string): MirrorUpdate {
    const next = text.split("\n");
    const old = this.lines;
    const oldHtml = this.html;
    const oldStates = this.states;
    const delta = next.length - old.length;

    // The common prefix, then the common suffix: what is left is the edit.
    let from = 0;
    while (from < next.length && from < old.length && next[from] === old[from])
      from++;
    let tail = 0;
    while (
      tail < next.length - from &&
      tail < old.length - from &&
      next[next.length - 1 - tail] === old[old.length - 1 - tail]
    )
      tail++;
    const reusableFrom = next.length - tail;

    if (from >= next.length && delta === 0)
      return { html: oldHtml, from: 0, to: 0, delta: 0 };

    const html = oldHtml.slice(0, from);
    const states = oldStates.slice(0, from + 1);
    let state = states[from] ?? INITIAL_SCAN;
    let to = next.length;
    for (let i = from; i < next.length; i++) {
      if (i >= reusableFrom) {
        const wasAt = i - delta;
        const was = oldStates[wasAt];
        if (was !== undefined && sameState(state, was)) {
          for (let k = wasAt; k < old.length; k++) {
            html.push(oldHtml[k] ?? "");
            states.push(oldStates[k + 1] ?? INITIAL_SCAN);
          }
          to = i;
          break;
        }
      }
      const scanned = scanOneLine(next[i] ?? "", this.lang, state);
      html.push(renderTokens(scanned.tokens));
      state = scanned.state;
      states.push(state);
    }

    this.lines = next;
    this.html = html;
    this.states = states;
    return { html, from, to, delta };
  }
}

function sameState(a: ScanState, b: ScanState): boolean {
  return (
    a.block === b.block &&
    a.tag === b.tag &&
    a.depth === b.depth &&
    a.scalar === b.scalar &&
    sameStr(a, b) &&
    (a.heredoc?.tag ?? null) === (b.heredoc?.tag ?? null) &&
    (a.embed?.lang ?? null) === (b.embed?.lang ?? null)
  );
}

function sameStr(a: ScanState, b: ScanState): boolean {
  if (a.str === null || b.str === null) return a.str === b.str;
  return a.str.close === b.str.close && a.str.escape === b.str.escape;
}

const api = {
  render,
  renderLines,
  detect,
  detectLanguage,
  languageFromFirstLine,
  renderTokens,
  scanOneLine,
  INITIAL_SCAN,
  Mirror,
};

declare global {
  // The editor's inline script reaches for exactly this, and nothing else.
  // eslint-disable-next-line no-var
  var forgeHighlight: typeof api | undefined;
}

globalThis.forgeHighlight = api;

export default api;
