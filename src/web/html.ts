/**
 * Server-side rendering as a tagged template literal. Interpolations are
 * escaped by default; the only way to emit markup from a value is `raw()`,
 * which is greppable and therefore reviewable. Components are just
 * functions returning Html. There is no framework to learn — this file is
 * the framework, and it fits on one screen.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A string that has already been made safe for HTML. */
export class Html {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

/** Mark trusted markup as safe. Every call site is an audit point. */
export function raw(text: string): Html {
  return new Html(text);
}

type Value = string | number | boolean | null | undefined | Html | Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof Html) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  if (typeof value === "string") return escapeHtml(value);
  return String(value);
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = "";
  for (const [i, chunk] of strings.entries()) {
    out += chunk;
    if (i < values.length) out += render(values[i]);
  }
  return new Html(out);
}

/** Conditional helper: `when(user, (u) => html`…`)` renders nothing on miss. */
export function when<T>(
  value: T | undefined | null | false,
  body: (value: T) => Html,
): Html {
  return value ? body(value) : new Html("");
}
